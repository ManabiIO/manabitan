import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {extractImportResult} from '../benchmark-support.js'
import {verifyReadback, verifyLayout, overlayFiles, timingFiles} from '../import-study-20261123/verify.mjs'

const root = path.resolve(process.argv[2])
const load = (name) => JSON.parse(readFileSync(path.join(root, name), 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const plan = load('plan.json')
const {config, dictionary, fixture} = plan
assert.equal(plan.authoritativeTiming, false)
assert.equal(plan.schedule.map(({arm}) => arm).join(''), plan.replication === 1 ? 'ABBA' : 'BAAB')
for (const [name, digest] of Object.entries(plan.sourceFiles)) assert.equal(hash(readFileSync(path.join(root, 'source', name))), digest)
assert.equal(hash(readFileSync(path.join(root, 'memory-harness.e2e.js'))), plan.memoryOverlaySha256)
assert.deepEqual(load('source/dev/perf/import-study-20261123/config.json'), config)
assert.deepEqual(load('source/test/perf/dictionaries.lock.json').dictionaries[dictionary], fixture)
const identities = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-identity.json`)]))
const packages = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-package-entries.json`)]))
const changed = [...new Set([...Object.keys(packages.A), ...Object.keys(packages.B)])].filter((name) => packages.A[name] !== packages.B[name]).sort()
assert.deepEqual(changed, config.expectedPackageDifferences)
assert.deepEqual(changed, load('package-differences.json'))
const media = load('media-reference.json')
let semantics = null
let browser = null
const physical = new Map()
const observations = []
for (const observation of plan.schedule) {
  const summary = load(`${observation.name}/summary.json`)
  const report = load(`${observation.name}/run-1.json`)
  const memory = load(`${observation.name}/memory.json`)
  const acquired = load(`${observation.name}/acquisition.json`)
  const markers = readFileSync(path.join(root, observation.name, 'markers.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(memory.windowMarkers, markers)
  const expectedSha = config[observation.arm === 'A' ? 'baseline' : 'candidate']
  assert.equal(identities[observation.arm].sha, expectedSha)
  assert.equal(summary.gitSha, expectedSha)
  assert.equal(summary.source.gitSha, expectedSha)
  assert.equal(summary.runs.length, 1)
  assert.equal(summary.mediaCheck, 'all')
  assert.equal(summary.traceEnabled, false)
  assert.equal(summary.importFlags, null)
  assert.equal(summary.source.sha256['builds/manabitan-chrome.zip'], identities[observation.arm].packageSha256)
  assert.equal(report.packageSha256, identities[observation.arm].packageSha256)
  for (const name of [...overlayFiles, ...timingFiles].filter((name) => name !== 'ext/js/core/safe-performance.js')) {
    const expected = name === 'test/chromium/extension-two-dictionary-import.e2e.js' ? plan.memoryOverlaySha256 : plan.sourceFiles[name]
    assert.equal(summary.source.sha256[name], expected, name)
  }
  const run = summary.runs[0]
  const recomputed = extractImportResult(report, dictionary, fixture, false, null, 'all')
  assert.deepEqual(Object.fromEntries(Object.keys(recomputed).map((name) => [name, run[name]])), recomputed)
  verifyReadback(run.validation, report.benchmark, dictionary, fixture, media)
  assert.ok(memory.windowDurationMs >= run.totalImportMs, 'Memory window omitted browser import time')
  semantics ??= run.validation.semanticProbes
  assert.deepEqual(run.validation.semanticProbes, semantics)
  browser ??= report.browserVersion
  assert.equal(report.browserVersion, browser)
  if (physical.has(observation.arm)) assert.deepEqual(run.validation.physicalProbes, physical.get(observation.arm))
  else physical.set(observation.arm, run.validation.physicalProbes)
  for (const key of ['index', 'arm', 'name', 'pair']) assert.equal(acquired[key], observation[key])
  assert.equal(acquired.retried, false)
  assert.equal(memory.authoritativeTiming, false)
  assert.equal(memory.observerRule, 'import-window-four-parallel-smaps-stable-single-thread-zombie-esrch-v2')
  assert.equal(memory.smapsReadConcurrencyLimit, 4)
  // Internal timing labels cannot detect this external sampler. No latency claim
  // is made from any duration in a memory-only observation.
  observations.push({name: observation.name, semanticDigestSha256: run.validation.semanticDigestSha256, media: run.validation.media, qualifiedForWholeTreePss: memory.qualifiedForWholeTreePss})
}
const result = {scope: 'Correctness and source/package binding for separate memory diagnostics; no authoritative elapsed-time result', authoritativeTiming: false, baseline: config.baseline, candidate: config.candidate, dictionary, replication: plan.replication, browserVersion: browser, observations, layoutDifferences: verifyLayout(physical.get('A'), physical.get('B'))}
writeFileSync(path.join(root, 'readback-verification.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result))
