import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {extractImportResult} from '../benchmark-support.js'

export const overlayFiles = [
  'test/perf/dictionaries.lock.json', 'dev/perf/dictionary-fixtures.js',
  'dev/perf/benchmark-support.js', 'dev/perf/import-benchmark.js', 'dev/perf/import-media-validation.js',
  'test/chromium/extension-two-dictionary-import.e2e.js'
]
export const timingFiles = [
  'package-lock.json', 'test/chromium/import-flags-ab-benchmark.js',
  'test/e2e/import-timing.js', 'ext/js/pages/settings/dictionary-import-controller.js',
  'ext/js/core/safe-performance.js'
]
export const sourceFiles = [
  ...overlayFiles, ...timingFiles, 'dev/perf/import-study-20261123/run.py',
  'dev/perf/import-study-20261123/verify.mjs', 'dev/perf/import-study-20261123/config.json'
]
const sha = (value) => createHash('sha256').update(value).digest('hex')
const jsonSha = (value) => sha(JSON.stringify(value))
const read = (file) => JSON.parse(readFileSync(file, 'utf8'))
const isDigest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const isCommit = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value)

export function mediaCheckFor(dictionary, observation) {
  return dictionary === 'vndb' && !(observation.kind === 'warmup' && ['A', 'B'].includes(observation.arm)) ? 'sample' : 'all'
}

export function schedule(stage, replication) {
  let orders
  if (stage === 'discovery') {
    assert.equal(replication, 1)
    orders = ['ABC', 'BCA', 'CAB']
  } else {
    assert.equal(stage, 'confirmation')
    assert.ok([1, 2].includes(replication))
    orders = ['ABC', 'CBA', 'BCA', 'ACB', 'CAB', 'BAC']
    if (replication === 2) orders.reverse()
  }
  const warmups = replication === 1 ? 'ABC' : 'CBA'
  return [
    ...[...warmups].map((arm) => ({name: `warmup-${arm}`, kind: 'warmup', triplet: 0, arm})),
    ...orders.flatMap((order, index) => [...order].map((arm) => ({name: `${arm}${index + 1}`, kind: 'measured', triplet: index + 1, arm})))
  ]
}

export function median(values) {
  assert.ok(values.length > 0)
  const ordered = [...values].sort((a, b) => a - b)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

export function compare(triplets, numerator, denominator, metric = 'totalImportMs') {
  const pairs = triplets.map((triplet, index) => {
    const baselineMs = triplet[denominator].metrics[metric]
    const candidateMs = triplet[numerator].metrics[metric]
    const measured = Number.isFinite(baselineMs) && baselineMs > 0 && Number.isFinite(candidateMs) && candidateMs >= 0
    return {triplet: index + 1, baselineMs, candidateMs, changePercent: measured ? 100 * (candidateMs / baselineMs - 1) : null}
  })
  const available = pairs.filter((pair) => pair.changePercent !== null)
  return {
    pairs, measuredPairs: available.length, missingOrZeroBaselinePairs: pairs.length - available.length,
    medianPairedChangePercent: available.length ? median(available.map((pair) => pair.changePercent)) : null,
    equalWorkChangePercent: available.length ? 100 * (available.reduce((sum, pair) => sum + pair.candidateMs, 0) / available.reduce((sum, pair) => sum + pair.baselineMs, 0) - 1) : null,
    fasterPairs: available.filter((pair) => pair.changePercent < 0).length
  }
}

function previewCount(probe) {
  return probe.rowSample.filter(({rawContentPreview: value}) => {
    assert.ok(value === null || typeof value === 'string')
    return typeof value === 'string' && value.length > 0 && !['<read-null>', '<read-failed>'].includes(value)
  }).length
}

export function verifyReadback(validation, benchmark, dictionary, fixture, mediaReference) {
  assert.equal(validation.probeCount, 12)
  assert.equal(validation.probeTerms.length, 12)
  assert.equal(new Set(validation.probeTerms).size, 12)
  assert.ok(validation.probeTerms.every((term) => typeof term === 'string' && term.length > 0))
  assert.ok(isDigest(validation.outputDigestSha256) && isDigest(validation.semanticDigestSha256))
  for (const state of [validation, validation.restart]) {
    assert.equal(state.title, fixture.expectedTitle)
    assert.equal(state.revision, fixture.revision)
    assert.equal(state.termRows, fixture.termRows)
    assert.equal(state.mediaRows, fixture.mediaFiles)
    assert.equal(state.contentReadable, true)
    assert.equal(state.probeCount, 12)
  }
  for (const name of ['preRestart', 'postRestart']) {
    const state = benchmark.readbackDiagnostics[name]
    assert.equal(jsonSha(state.semanticProbes), state.semanticDigestSha256)
    assert.equal(jsonSha(state.physicalProbes), state.physicalDigestSha256)
    assert.equal(state.semanticDigestSha256, validation.semanticDigestSha256)
    assert.equal(state.physicalDigestSha256, validation.outputDigestSha256)
    assert.deepEqual(state.semanticProbes, validation.semanticProbes)
    assert.deepEqual(state.physicalProbes, validation.physicalProbes)
    assert.deepEqual(state.semanticProbes.map(({term}) => term), validation.probeTerms)
    assert.deepEqual(state.physicalProbes.map(({term}) => term), validation.probeTerms)
    let entries = 0
    for (const {result} of state.semanticProbes) {
      assert.ok(Array.isArray(result.dictionaryEntries) && result.dictionaryEntries.length > 0)
      assert.equal(result.dictionaryAvailability?.length ?? 0, 0)
      entries += result.dictionaryEntries.length
    }
    assert.ok(entries >= 12)
    assert.equal(entries, validation.semanticProbeEntryCount)
    for (const term of state.physicalProbes) {
      assert.ok(term.probes.length > 0)
      for (const probe of term.probes) {
        assert.equal(probe.term, term.term)
        assert.equal(probe.rowSampleCount, probe.rowSample.length)
        assert.equal(probe.readablePreviewRowCount, previewCount(probe))
        assert.equal(probe.glossaryReadyRowCount, probe.rowSample.filter((row) => row.glossaryLength > 0).length)
        assert.ok(probe.glossaryReadyRowCount > 0)
        assert.equal(probe.outOfBoundsRowCount, 0)
      }
    }
  }
  assert.deepEqual(validation.media, mediaReference)
  const byTerm = new Map(validation.semanticProbes.map(({term, result}) => [term, result]))
  for (const row of validation.lookup.observations) {
    const result = byTerm.get(row.term)
    assert.equal(row.sha256, jsonSha(result), 'Complete public lookup differs from timed lookup receipt')
    assert.equal(row.results, result.dictionaryEntries.length)
  }
}

export function differences(a, b, location = '') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return [{path: location, baseline: a, candidate: b}]
  if (a !== null && typeof a === 'object') {
    assert.deepEqual(Object.keys(a), Object.keys(b), `Different physical shape: ${location}`)
    return Object.keys(a).flatMap((key) => differences(a[key], b[key], `${location}/${key}`))
  }
  return a === b ? [] : [{path: location, baseline: a, candidate: b}]
}

export function verifyLayout(a, b) {
  const changes = differences(a, b)
  for (const change of changes) {
    if (/^\/[0-9]+\/probes\/[0-9]+\/rowSample\/[0-9]+\/(rawEntryContentOffset|rawContentPreview)$/.test(change.path)) continue
    const counter = /^\/([0-9]+)\/probes\/([0-9]+)\/readablePreviewRowCount$/.exec(change.path)
    assert.ok(counter, `Unexplained physical change: ${change.path}`)
    const before = a[Number(counter[1])].probes[Number(counter[2])]
    const after = b[Number(counter[1])].probes[Number(counter[2])]
    assert.equal(before.readablePreviewRowCount, previewCount(before))
    assert.equal(after.readablePreviewRowCount, previewCount(after))
    assert.ok(before.rowSample.some((row, index) => row.rawContentPreview !== after.rowSample[index].rawContentPreview))
  }
  return changes
}

function metrics(run) {
  const phases = run.importDebug.importerPhaseTimings ?? []
  const phase = (name) => {
    const matches = phases.filter((value) => value.phase === name)
    assert.ok(matches.length <= 1)
    return matches[0] ?? null
  }
  const optional = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
  const final = phase('bulk-finalization')
  return {
    totalImportMs: run.totalImportMs,
    archiveAndIndexMs: optional(phase('archive-and-index')?.elapsedMs),
    importDataBanksMs: optional(phase('import-data-banks')?.elapsedMs),
    bulkFinalizationMs: optional(final?.elapsedMs),
    termRecordCloseMs: optional(final?.details?.termRecordEndImportSessionCloseWritableMs),
    termRecordFlushPendingMs: optional(final?.details?.termRecordEndImportSessionFlushPendingWritesMs),
    termRecordAwaitQueuedMs: optional(final?.details?.termRecordEndImportSessionAwaitQueuedWritesMs),
    termContentEndSessionMs: optional(final?.details?.termContentEndImportSessionMs)
  }
}

export function verifyStudy(directory) {
  const root = path.resolve(directory)
  const load = (name) => read(path.join(root, name))
  const plan = load('plan.json')
  const {config, dictionary, replication, fixture} = plan
  assert.equal(plan.schemaVersion, 1)
  assert.equal(config.schemaVersion, 1)
  assert.ok(isCommit(config.baseline) && isCommit(config.candidate) && isCommit(plan.harnessSha))
  assert.notEqual(config.baseline, config.candidate)
  assert.deepEqual(config.dictionaries, ['jmdict', 'jitendex', 'vndb'])
  assert.equal(config.mediaReadbackPolicy, 'all-jm-jt-first-ab-full-vndb-64-remaining-v1')
  assert.ok(config.dictionaries.includes(dictionary))
  assert.equal(plan.nodeVersion, 'v22.22.0')
  assert.deepEqual(plan.schedule, schedule(config.stage, replication))
  assert.deepEqual(plan.mediaChecks, Object.fromEntries(plan.schedule.map((item) => [item.name, mediaCheckFor(dictionary, item)])))
  assert.deepEqual(Object.keys(plan.sourceFiles).sort(), [...sourceFiles].sort())
  for (const [name, hash] of Object.entries(plan.sourceFiles)) assert.equal(sha(readFileSync(path.join(root, 'source', name))), hash)
  assert.deepEqual(load('source/dev/perf/import-study-20261123/config.json'), config)
  assert.deepEqual(load('source/test/perf/dictionaries.lock.json').dictionaries[dictionary], fixture)
  const identities = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-identity.json`)]))
  const packages = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-package-entries.json`)]))
  for (const arm of ['A', 'B']) {
    assert.equal(identities[arm].sha, arm === 'A' ? config.baseline : config.candidate)
    assert.ok(isDigest(identities[arm].packageSha256))
    const changed = identities[arm].statusWithHarnessOverlay.split('\n').filter(Boolean).map((line) => line.trim().replace(/^\S+\s+/, ''))
    assert.ok(changed.every((name) => [...overlayFiles, 'node_modules'].includes(name)), `Unrecorded source mutation in ${arm}`)
  }
  const packageDifferences = [...new Set([...Object.keys(packages.A), ...Object.keys(packages.B)])].filter((name) => packages.A[name] !== packages.B[name]).sort()
  assert.deepEqual(packageDifferences, config.expectedPackageDifferences)
  assert.deepEqual(packageDifferences, load('package-differences.json'))
  assert.ok(packageDifferences.length > 0)
  const mediaReferences = load('media-reference.json')
  assert.deepEqual(Object.keys(mediaReferences).sort(), ['all', 'sample'])
  for (const [mode, reference] of Object.entries(mediaReferences)) {
    assert.deepEqual(Object.keys(reference).sort(), ['mode', 'totalFiles', 'totalBytes', 'files', 'bytes', 'sha256'].sort())
    assert.equal(reference.mode, mode)
    assert.equal(reference.files, mode === 'all' ? fixture.mediaFiles : Math.min(fixture.mediaFiles, 64))
    assert.equal(reference.totalFiles, fixture.mediaFiles)
    assert.equal(reference.totalBytes, fixture.mediaBytes)
    assert.ok(Number.isSafeInteger(reference.bytes) && reference.bytes >= 0 && reference.bytes <= fixture.mediaBytes)
    if (mode === 'all') assert.equal(reference.bytes, fixture.mediaBytes)
    assert.ok(isDigest(reference.sha256))
  }
  const observations = []
  const physical = new Map()
  let semantic = null
  let browserVersion = null
  for (const observation of plan.schedule) {
    const arm = observation.arm === 'B' ? 'B' : 'A'
    const mediaCheck = plan.mediaChecks[observation.name]
    const summary = load(`${observation.name}/summary.json`)
    const report = load(`${observation.name}/run-1.json`)
    assert.equal(summary.runs.length, 1)
    const run = summary.runs[0]
    const recomputed = extractImportResult(report, dictionary, fixture, false, null, mediaCheck)
    assert.deepEqual(Object.fromEntries(Object.keys(recomputed).map((name) => [name, run[name]])), recomputed)
    assert.equal(summary.gitSha, identities[arm].sha)
    assert.equal(summary.source.gitSha, identities[arm].sha)
    assert.equal(summary.source.sha256['builds/manabitan-chrome.zip'], identities[arm].packageSha256)
    for (const name of [...overlayFiles, ...timingFiles].filter((name) => name !== 'ext/js/core/safe-performance.js')) assert.equal(summary.source.sha256[name], plan.sourceFiles[name])
    assert.equal(summary.dictionary, dictionary)
    assert.deepEqual(summary.fixture, fixture)
    assert.equal(summary.buildTarget, 'chrome')
    assert.equal(report.buildTarget, 'chrome')
    assert.equal(report.packageSha256, identities[arm].packageSha256)
    assert.equal(run.packageSha256, identities[arm].packageSha256)
    assert.equal(summary.authoritativeTiming, true)
    assert.equal(summary.traceEnabled, false)
    assert.equal(summary.importFlags, null)
    assert.equal(summary.mediaCheck, mediaCheck)
    assert.equal(report.browserVersion, summary.browserVersion)
    assert.equal(report.browserVersion, run.browserVersion)
    assert.ok(typeof report.browserVersion === 'string' && report.browserVersion.length > 0)
    browserVersion ??= report.browserVersion
    assert.equal(report.browserVersion, browserVersion)
    verifyReadback(run.validation, report.benchmark, dictionary, fixture, mediaReferences[mediaCheck])
    semantic ??= run.validation.semanticProbes
    assert.deepEqual(run.validation.semanticProbes, semantic, `${observation.name}: complete public lookup changed`)
    if (physical.has(arm)) assert.deepEqual(run.validation.physicalProbes, physical.get(arm), `${observation.name}: same-package layout changed`)
    else physical.set(arm, run.validation.physicalProbes)
    for (const name of ['host-before', 'host-after']) {
      const host = load(`${observation.name}/${name}.json`)
      assert.equal(host.nodeVersion, 'v22.22.0')
      assert.ok(Array.isArray(host.loadAverage) && host.loadAverage.length === 3)
    }
    observations.push({...observation, metrics: metrics(run), packageSha256: run.packageSha256, mediaCheck, mediaFilesVerified: run.validation.media.files, mediaBytesVerified: run.validation.media.bytes})
  }
  const layoutDifferences = verifyLayout(physical.get('A'), physical.get('B'))
  const triplets = []
  for (let index = 1; index <= (config.stage === 'discovery' ? 3 : 6); ++index) {
    const selected = observations.filter((value) => value.kind === 'measured' && value.triplet === index)
    assert.equal(selected.length, 3)
    const triplet = Object.fromEntries(selected.map((value) => [value.arm, value]))
    assert.deepEqual(Object.keys(triplet).sort(), ['A', 'B', 'C'])
    triplets.push(triplet)
  }
  const comparisons = {}
  for (const metric of Object.keys(observations[0].metrics)) {
    comparisons[metric] = {candidateVersusA: compare(triplets, 'B', 'A', metric), candidateVersusC: compare(triplets, 'B', 'C', metric), identicalCodeControl: compare(triplets, 'C', 'A', metric)}
  }
  const primary = comparisons.totalImportMs
  const requiredFaster = config.stage === 'discovery' ? 2 : 5
  const meetsThreshold = [primary.candidateVersusA, primary.candidateVersusC].every((value) => value.measuredPairs === triplets.length && value.medianPairedChangePercent <= -5 && value.equalWorkChangePercent < 0 && value.fasterPairs >= requiredFaster)
  return {
    schemaVersion: 1, stage: config.stage, dictionary, replication, baselineSha: config.baseline,
    candidateSha: config.candidate, harnessSha: plan.harnessSha, browserVersion,
    harnessFileSha256: Object.fromEntries(sourceFiles.filter((name) => !name.endsWith('/config.json')).map((name) => [name, plan.sourceFiles[name]])),
    packages: identities, packageDifferences, warmups: 3, measuredImports: triplets.length * 3,
    observations, comparisons, semanticDigestSha256: jsonSha(semantic), semanticEntryCount: semantic.reduce((sum, {result}) => sum + result.dictionaryEntries.length, 0),
    layoutDifferences, meetsMaterialityAndDirectionThreshold: meetsThreshold,
    mediaProbeCount: mediaReferences.all.files,
    totalMediaFilesVerified: observations.reduce((sum, row) => sum + row.mediaFilesVerified, 0),
    mediaCheckCounts: {all: observations.filter((row) => row.mediaCheck === 'all').length, sample: observations.filter((row) => row.mediaCheck === 'sample').length},
    mediaProbeScope: dictionary === 'vndb' ? 'all image bytes in first A/B warmups; fixed 64-image sample in all other imports; both independently matched against complete source references' : 'all referenced image bytes after every restart, independently matched against complete source references',
    decision: config.stage === 'discovery' ? (meetsThreshold ? 'promising; requires two independent confirmations' : 'not promising under the predeclared screen') : 'combine both independent replications before any promotion claim',
    limits: 'All observations and tails retained. Sampled complete responses, not exhaustive all-term readback. Phase times may overlap. Identical-code controls are reported separately without subtraction. No peak-memory claim.'
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyStudy(process.argv[2])
  writeFileSync(path.join(process.argv[2], 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result))
}
