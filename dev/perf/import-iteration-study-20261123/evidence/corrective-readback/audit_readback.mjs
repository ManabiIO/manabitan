import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {existsSync, readFileSync, readdirSync, lstatSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'

// Read-only receipt verification. This never loads Manabitan or starts a browser.
const root = path.resolve(process.argv[2] ?? path.dirname(fileURLToPath(import.meta.url)))
const output = process.argv[3]
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const jsonSha = (value) => sha(JSON.stringify(value))
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'))
const validDigest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const baseline = '1e235059a4c05c2509e8757fccba43a2d60222df'
const candidate = '51f095912b11ddd158ac173698eb322e2be99d12'
const campaigns = [
  {id: 45112249581, head: 'a2bd2b8266898983ea1f7df0c44282495df0c0f3', prefix: 'import-readback-20261123', dictionaries: ['jmdict', 'jitendex', 'vndb'], allowDerivedCounter: false},
  {id: 45113545482, head: 'd9268d445d528da74a452e75d07872eebd9b7e00', prefix: 'import-readback-final-20261123', dictionaries: ['jitendex'], allowDerivedCounter: true},
]
const overlay = ['test/perf/dictionaries.lock.json', 'dev/perf/dictionary-fixtures.js', 'dev/perf/benchmark-support.js', 'dev/perf/import-benchmark.js', 'test/chromium/extension-two-dictionary-import.e2e.js']
const referenceNames = [...overlay, 'package-lock.json', 'test/chromium/import-flags-ab-benchmark.js', 'test/e2e/import-timing.js', 'ext/js/pages/settings/dictionary-import-controller.js']
const expectedPackageDifferences = ['js/dictionary/term-bank-wasm-parser-worker.js', 'js/dictionary/term-bank-wasm-parser.js'].sort()
const expectedMedia = {jmdict: 0, jitendex: 236, vndb: 146570}
const expectedSemanticEntries = {jmdict: 12, jitendex: 17, vndb: 13}
const semanticByDictionary = new Map()
const physicalByDictionaryAndArm = new Map()
const packagedFilesByArm = new Map()
const referenceHashesByPath = new Map()

function memberPath(base, name) {
  assert.ok(typeof name === 'string' && name.length > 0 && !name.includes('\\'))
  assert.ok(!name.startsWith('/') && !name.split('/').some((part) => part === '..' || part === '.' || part === ''))
  const result = path.resolve(base, name)
  assert.ok(result.startsWith(`${path.resolve(base)}${path.sep}`))
  assert.equal(lstatSync(result).isSymbolicLink(), false)
  return result
}

function filesUnder(directory, prefix = '') {
  return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
    assert.equal(entry.isSymbolicLink(), false)
    const name = `${prefix}${entry.name}`
    return entry.isDirectory() ? filesUnder(path.join(directory, entry.name), `${name}/`) : [name]
  }).sort()
}

function schedule(replication) {
  const values = [...(replication === 1 ? 'AB' : 'BA')].map((arm) => ['warmup', 0, arm])
  for (let pair = 0; pair < 2; ++pair) values.push(['control-before', pair, 'A'], ['control-before', pair, 'A'])
  for (let pair = 0; pair < 8; ++pair) {
    for (const arm of (pair + replication) % 2 === 1 ? 'AB' : 'BA') values.push(['candidate', pair, arm])
  }
  for (let pair = 0; pair < 2; ++pair) values.push(['control-after', pair, 'A'], ['control-after', pair, 'A'])
  return values
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b)
  assert.ok(ordered.length > 0)
  const middle = Math.floor(ordered.length / 2)
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2
}

function summarize(pairs) {
  return {pairs, pairCount: pairs.length, medianChangePercent: median(pairs.map((value) => value.changePercent)),
    medianDeltaMs: median(pairs.map((value) => value.comparisonMs - value.baselineMs)),
    baselineMedianMs: median(pairs.map((value) => value.baselineMs)), comparisonMedianMs: median(pairs.map((value) => value.comparisonMs)),
    minChangePercent: Math.min(...pairs.map((value) => value.changePercent)), maxChangePercent: Math.max(...pairs.map((value) => value.changePercent)),
    fasterPairs: pairs.filter((value) => value.comparisonMs < value.baselineMs).length}
}

function pairsFor(observations, kind) {
  const result = []
  for (let pair = 0; pair < (kind === 'candidate' ? 8 : 2); ++pair) {
    const rows = observations.filter((value) => value.kind === kind && value.pair === pair)
    assert.equal(rows.length, 2)
    const a = kind === 'candidate' ? rows.find((value) => value.arm === 'A') : rows[0]
    const b = kind === 'candidate' ? rows.find((value) => value.arm === 'B') : rows[1]
    for (const value of [a.totalImportMs, b.totalImportMs]) assert.ok(typeof value === 'number' && Number.isFinite(value) && value > 0)
    result.push({kind, pair, order: rows.map((value) => value.arm).join(''), observationIndexes: rows.map((value) => value.index),
      baselineMs: a.totalImportMs, comparisonMs: b.totalImportMs, changePercent: 100 * (b.totalImportMs / a.totalImportMs - 1)})
  }
  return summarize(result)
}

function differences(a, b, location = '') {
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) return [{path: location, baseline: a, candidate: b}]
  if (a !== null && typeof a === 'object') {
    assert.deepEqual(Object.keys(a), Object.keys(b), `Different physical shape at ${location}`)
    return Object.keys(a).flatMap((key) => differences(a[key], b[key], `${location}/${key}`))
  }
  return a === b ? [] : [{path: location, baseline: a, candidate: b}]
}

function previewCount(probe) {
  return probe.rowSample.filter((row) => {
    assert.ok(row.rawContentPreview === null || typeof row.rawContentPreview === 'string')
    return typeof row.rawContentPreview === 'string' && row.rawContentPreview.length > 0 && !['<read-null>', '<read-failed>'].includes(row.rawContentPreview)
  }).length
}

let checkedStates = 0
let checkedPhysicalCounters = 0
let checkedPhysicalRows = 0
const cells = []
const memoryCoverage = {runs: 0, samples: 0, discoveredPidCountHistogram: {}, wholeTreeCoverageEstablished: false, suitableForMemoryNonRegressionClaim: false}
for (const campaign of campaigns) {
  const campaignRoot = path.join(root, String(campaign.id))
  const metadata = readJson(path.join(campaignRoot, 'metadata.json'))
  const source = readJson(path.join(campaignRoot, 'source-identity.json'))
  assert.equal(metadata.runId, campaign.id)
  assert.equal(source.commit, campaign.head)
  assert.equal(metadata.jobs.length, campaign.dictionaries.length * 2)
  assert.equal(metadata.artifacts.length, campaign.dictionaries.length * 2)
  for (const [name, identity] of Object.entries(source.files)) {
    const data = readFileSync(memberPath(path.join(campaignRoot, 'source'), name))
    assert.equal(data.length, identity.bytes)
    assert.equal(sha(data), identity.sha256)
  }
  for (const name of referenceNames) {
    const hash = source.files[name].sha256
    if (referenceHashesByPath.has(name)) assert.equal(hash, referenceHashesByPath.get(name), `JavaScript timing harness changed across campaigns: ${name}`)
    else referenceHashesByPath.set(name, hash)
  }
  const fixtureLock = readJson(path.join(campaignRoot, 'source/test/perf/dictionaries.lock.json'))
  const specifications = readJson(path.join(campaignRoot, 'source/dev/perf/import-iteration-study-20261123/candidates.json'))
  for (const dictionary of campaign.dictionaries) for (const replication of [1, 2]) {
    const cellName = `owned-shared-${dictionary}-${replication}`
    const cellRoot = path.join(campaignRoot, cellName)
    const prefix = `owned-shared/${dictionary}/${replication}/`
    const evidence = path.join(cellRoot, prefix)
    const receipt = readJson(path.join(cellRoot, 'artifact-manifest.json'))
    const advertised = metadata.artifacts.find((value) => value.id === receipt.artifact.id)
    assert.deepEqual(receipt.artifact, advertised)
    assert.equal(advertised.name, `${campaign.prefix}-${cellName}`)
    assert.equal(advertised.workflow_run.id, campaign.id)
    assert.equal(advertised.workflow_run.head_sha, campaign.head)
    assert.equal(advertised.workflow_run.repository_id, 1165902460)
    assert.equal(advertised.workflow_run.head_repository_id, 1165902460)
    assert.equal(receipt.verifiedZipSha256, advertised.digest.replace(/^sha256:/, ''))
    assert.equal(receipt.verifiedZipBytes, advertised.size_in_bytes)
    assert.equal(receipt.safeExtraction, true)
    assert.equal(receipt.memberCount, receipt.members.length)
    const inventory = new Map()
    for (const member of receipt.members) {
      assert.ok(member.path.startsWith(prefix))
      assert.equal(inventory.has(member.path), false)
      const data = readFileSync(memberPath(cellRoot, member.path))
      assert.equal(data.length, member.bytes)
      assert.equal(sha(data), member.sha256)
      inventory.set(member.path, member)
    }
    assert.deepEqual(filesUnder(evidence).map((name) => prefix + name).sort(), [...inventory.keys()].sort())
    if (existsSync(path.join(cellRoot, 'artifact.zip'))) {
      const bytes = readFileSync(path.join(cellRoot, 'artifact.zip'))
      assert.equal(bytes.length, advertised.size_in_bytes)
      assert.equal(sha(bytes), receipt.verifiedZipSha256)
    }
    const rawIdentity = (name) => {
      const value = inventory.get(prefix + name)
      assert.ok(value, `Unlisted raw input ${name}`)
      return {path: value.path, bytes: value.bytes, sha256: value.sha256}
    }
    const load = (name) => { rawIdentity(name); return readJson(path.join(evidence, name)) }
    const plan = load('plan.json')
    const fixture = fixtureLock.dictionaries[dictionary]
    assert.equal(plan.harness, campaign.head)
    assert.equal(plan.baseline, baseline)
    assert.equal(plan.candidate, candidate)
    assert.equal(plan.candidateName, 'owned-shared')
    assert.equal(plan.dictionary, dictionary)
    assert.equal(plan.replication, replication)
    assert.equal(plan.node, 'v22.22.0')
    assert.deepEqual(plan.specification, specifications['owned-shared'])
    assert.deepEqual(plan.schedule, schedule(replication))
    assert.deepEqual(plan.overlaidHarnessFiles, Object.fromEntries(overlay.map((name) => [name, source.files[name].sha256])))
    const identities = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-identity.json`)]))
    const packages = Object.fromEntries(['A', 'B'].map((arm) => [arm, load(`${arm}-package-entries.json`)]))
    for (const arm of ['A', 'B']) {
      assert.equal(identities[arm].sha, arm === 'A' ? baseline : candidate)
      assert.ok(validDigest(identities[arm].packageSha256))
      const changed = identities[arm].statusWithHarnessOverlay.split('\n').filter(Boolean).map((line) => line.trim().replace(/^\S+\s+/, ''))
      assert.ok(changed.every((name) => [...overlay, 'node_modules'].includes(name)))
      if (packagedFilesByArm.has(arm)) assert.deepEqual(packages[arm], packagedFilesByArm.get(arm), 'Packaged member bytes changed across campaigns or replications')
      else packagedFilesByArm.set(arm, packages[arm])
    }
    const packageDifferences = [...new Set([...Object.keys(packages.A), ...Object.keys(packages.B)])].filter((name) => packages.A[name] !== packages.B[name]).sort()
    assert.deepEqual(packageDifferences, expectedPackageDifferences)
    assert.deepEqual(load('package-differences.json'), packageDifferences)
    const job = metadata.jobs.find((value) => value.name === `compare (owned-shared, ${dictionary}, ${replication})`)
    assert.ok(job)
    assert.equal(job.run_id, campaign.id)
    assert.equal(job.status, 'completed')
    const observations = load('observations.json')
    assert.equal(observations.length, 26)
    const digests = {A: new Set(), B: new Set()}
    const semanticDigests = new Set()
    const browserVersions = new Set()
    const physicalByArm = new Map()
    const observationReceipts = []
    function verifyRun(directory, arm, observation = null) {
      const summary = load(`${directory}/summary.json`)
      const report = load(`${directory}/run-1.json`)
      assert.equal(summary.runs.length, 1)
      const result = summary.runs[0]
      const validation = result.validation
      const benchmark = report.benchmark
      const expectedSource = arm === 'A' ? baseline : candidate
      assert.equal(summary.gitSha, expectedSource)
      assert.equal(summary.source.gitSha, expectedSource)
      assert.equal(report.packageSha256, identities[arm].packageSha256)
      assert.equal(result.packageSha256, identities[arm].packageSha256)
      assert.equal(summary.source.sha256['builds/manabitan-chrome.zip'], identities[arm].packageSha256)
      for (const name of referenceNames) assert.equal(summary.source.sha256[name], source.files[name].sha256, `Changed timing source ${name}`)
      assert.equal(summary.authoritativeTiming, true)
      assert.equal(summary.traceEnabled, false)
      assert.equal(summary.importFlags, null)
      assert.equal(summary.buildTarget, 'chrome')
      assert.equal(report.buildTarget, 'chrome')
      assert.equal(summary.dictionary, dictionary)
      for (const name of ['cacheFile', 'release', 'url', 'sha256', 'sizeBytes', 'expectedTitle', 'revision', 'termRows']) assert.deepEqual(summary.fixture[name], fixture[name])
      assert.equal(report.status, 'success')
      assert.equal(report.skippedVerification, false)
      assert.equal(benchmark.dictionary, dictionary)
      for (const name of ['authoritativeTiming', 'pinnedDictionaries', 'productionImportDefaults']) assert.equal(benchmark[name], true)
      for (const name of ['traceEnabled', 'phaseProfiling', 'phaseScreenshots', 'processSampling']) assert.equal(benchmark[name], false)
      assert.equal(benchmark.importFlags, null)
      assert.equal(report.browserVersion, summary.browserVersion)
      assert.equal(report.browserVersion, result.browserVersion)
      assert.ok(typeof report.browserVersion === 'string' && report.browserVersion.length > 0)
      browserVersions.add(report.browserVersion)
      assert.deepEqual(validation, benchmark.validation)
      if (observation) {
        assert.deepEqual(validation, observation.validation)
        assert.equal(result.packageSha256, observation.packageSha256)
        assert.equal(result.totalImportMs, observation.totalImportMs)
      }
      const timings = report.phases.filter((phase) => phase.data?.kind === 'dictionary-import').map((phase) => phase.data.browserTiming)
      assert.equal(timings.length, 1)
      assert.equal(timings[0].trigger, 'file-input-change')
      assert.equal(timings[0].errorCount, 0)
      assert.equal(timings[0].completedAtMs - timings[0].startedAtMs, result.totalImportMs)
      for (const name of ['errorCount', 'addSettingsErrorCount']) assert.equal(result.importDebug[name], 0)
      assert.equal(result.importDebug.hasResult, true)
      assert.equal(result.importDebug.usesFallbackStorage, false)
      for (const state of [validation, validation.restart]) {
        assert.equal(state.title, fixture.expectedTitle)
        assert.equal(String(state.revision), fixture.revision)
        assert.equal(state.termRows, fixture.termRows)
        assert.equal(state.mediaRows, expectedMedia[dictionary])
        assert.equal(state.contentReadable, true)
        assert.equal(state.probeCount, 12)
      }
      assert.equal(validation.semanticProbeEntryCount, expectedSemanticEntries[dictionary])
      assert.equal(validation.probeTerms.length, 12)
      assert.ok(validDigest(validation.outputDigestSha256) && validDigest(validation.semanticDigestSha256))
      const states = []
      for (const stateName of ['preRestart', 'postRestart']) {
        const state = benchmark.readbackDiagnostics[stateName]
        assert.equal(jsonSha(state.physicalProbes), state.physicalDigestSha256)
        assert.equal(jsonSha(state.semanticProbes), state.semanticDigestSha256)
        assert.equal(state.physicalDigestSha256, validation.outputDigestSha256)
        assert.equal(state.semanticDigestSha256, validation.semanticDigestSha256)
        assert.deepEqual(state.physicalProbes, validation.physicalProbes)
        assert.deepEqual(state.semanticProbes, validation.semanticProbes)
        assert.equal(state.physicalProbes.length, 12)
        assert.equal(state.semanticProbes.length, 12)
        assert.deepEqual(state.semanticProbes.map((value) => value.term), validation.probeTerms)
        assert.deepEqual(state.physicalProbes.map((value) => value.term), validation.probeTerms)
        let entries = 0
        for (const {result: semantic} of state.semanticProbes) {
          assert.ok(Array.isArray(semantic.dictionaryEntries) && semantic.dictionaryEntries.length > 0)
          assert.equal(semantic.dictionaryAvailability?.length ?? 0, 0)
          entries += semantic.dictionaryEntries.length
        }
        assert.equal(entries, expectedSemanticEntries[dictionary])
        if (semanticByDictionary.has(dictionary)) assert.deepEqual(state.semanticProbes, semanticByDictionary.get(dictionary))
        else semanticByDictionary.set(dictionary, state.semanticProbes)
        const key = `${dictionary}/${arm}`
        if (physicalByDictionaryAndArm.has(key)) assert.deepEqual(state.physicalProbes, physicalByDictionaryAndArm.get(key))
        else physicalByDictionaryAndArm.set(key, state.physicalProbes)
        if (physicalByArm.has(arm)) assert.deepEqual(state.physicalProbes, physicalByArm.get(arm))
        else physicalByArm.set(arm, state.physicalProbes)
        let rows = 0
        for (const term of state.physicalProbes) for (const probe of term.probes) {
          assert.equal(probe.rowSampleCount, probe.rowSample.length)
          assert.equal(probe.readablePreviewRowCount, previewCount(probe))
          assert.equal(probe.glossaryReadyRowCount, probe.rowSample.filter((row) => row.glossaryLength > 0).length)
          assert.ok(probe.glossaryReadyRowCount > 0)
          assert.equal(probe.totalLength, -1)
          assert.equal(probe.inBoundsRowCount, 0)
          assert.equal(probe.outOfBoundsRowCount, 0)
          rows += probe.rowSample.length
          ++checkedPhysicalCounters
        }
        if (dictionary === 'jitendex') {
          const probe = state.physicalProbes.at(-1).probes[0]
          assert.equal(probe.term, 'ＪＭｄｉｃｔ')
          assert.equal(probe.rowSample.length, 1)
          const row = probe.rowSample[0]
          assert.equal(row.rawEntryContentLength, 643)
          assert.equal(row.rawEntryContentOffset, arm === 'A' ? 38215059 : 36669238)
          assert.equal(probe.glossaryReadyRowCount, 1)
          assert.equal(probe.readablePreviewRowCount, arm === 'A' ? 0 : 1)
          if (arm === 'A') assert.equal(row.rawContentPreview, '<read-null>')
          else assert.ok(row.rawContentPreview.includes('MBC2'))
        }
        ++checkedStates
        checkedPhysicalRows += rows
        states.push({state: stateName, physicalDigestSha256: state.physicalDigestSha256, semanticDigestSha256: state.semanticDigestSha256, semanticEntries: entries, physicalRows: rows})
      }
      digests[arm].add(validation.outputDigestSha256)
      semanticDigests.add(validation.semanticDigestSha256)
      return {summary: rawIdentity(`${directory}/summary.json`), report: rawIdentity(`${directory}/run-1.json`), states}
    }
    for (const [index, observation] of observations.entries()) {
      assert.equal(observation.index, index)
      assert.deepEqual([observation.kind, observation.pair, observation.arm], schedule(replication)[index])
      const directory = `${String(index).padStart(2, '0')}-${observation.kind}-${observation.pair}-${observation.arm}`
      observationReceipts.push({index, kind: observation.kind, pair: observation.pair, arm: observation.arm,
        totalImportMs: observation.totalImportMs, packageSha256: observation.packageSha256, ...verifyRun(directory, observation.arm, observation)})
    }
    assert.equal(semanticDigests.size, 1)
    assert.equal(digests.A.size, 1)
    assert.equal(digests.B.size, 1)
    assert.equal(browserVersions.size, 1)
    const layoutDifferences = differences(physicalByArm.get('A'), physicalByArm.get('B'))
    const derivedDifferences = []
    for (const value of layoutDifferences) {
      if (/^\/[0-9]+\/probes\/[0-9]+\/rowSample\/[0-9]+\/(rawEntryContentOffset|rawContentPreview)$/.test(value.path)) continue
      const match = /^\/([0-9]+)\/probes\/([0-9]+)\/readablePreviewRowCount$/.exec(value.path)
      assert.ok(match, `Unexplained physical difference: ${value.path}`)
      const a = physicalByArm.get('A')[Number(match[1])].probes[Number(match[2])]
      const b = physicalByArm.get('B')[Number(match[1])].probes[Number(match[2])]
      assert.equal(a.readablePreviewRowCount, previewCount(a))
      assert.equal(b.readablePreviewRowCount, previewCount(b))
      assert.ok(a.rowSample.some((row, index) => row.rawContentPreview !== b.rowSample[index].rawContentPreview))
      derivedDifferences.push(value)
    }
    if (dictionary === 'jitendex') {
      assert.equal(layoutDifferences.length, 25)
      assert.deepEqual(derivedDifferences, [{path: '/11/probes/0/readablePreviewRowCount', baseline: 0, candidate: 1}])
    } else assert.deepEqual(layoutDifferences, [])
    const physicalDigests = Object.fromEntries(['A', 'B'].map((arm) => [arm, [...digests[arm]]]))
    assert.deepEqual(load('layout-differences.json'), {physicalDigests, semanticDigests: [...semanticDigests], differences: layoutDifferences})
    const originalGuardPass = campaign.allowDerivedCounter || derivedDifferences.length === 0
    assert.equal(job.conclusion, originalGuardPass ? 'success' : 'failure')
    const resultsPresent = existsSync(path.join(evidence, 'results.json'))
    assert.equal(resultsPresent, originalGuardPass)
    const pairs = Object.fromEntries(['candidate', 'control-before', 'control-after'].map((kind) => [kind, pairsFor(observations, kind)]))
    pairs['controls-all'] = summarize([...pairs['control-before'].pairs, ...pairs['control-after'].pairs])
    if (resultsPresent) {
      const reported = load('results.json')
      for (const kind of ['candidate', 'control-before', 'control-after']) {
        assert.equal(reported[kind].medianChangePercent, pairs[kind].medianChangePercent)
        assert.equal(reported[kind].fasterPairs, pairs[kind].fasterPairs)
        assert.deepEqual(reported[kind].pairs, pairs[kind].pairs.map(({pair, baselineMs, comparisonMs, changePercent}) => ({pair, baselineMs, comparisonMs, changePercent})))
      }
    }
    const memoryObservations = existsSync(path.join(evidence, 'memory-observations.json')) ? load('memory-observations.json') : []
    assert.equal(memoryObservations.length, originalGuardPass ? 4 : 0)
    const memoryReceipts = []
    for (const [index, observation] of memoryObservations.entries()) {
      const arm = (replication === 1 ? 'ABBA' : 'BAAB')[index]
      assert.equal(observation.index, index)
      assert.equal(observation.arm, arm)
      const directory = `memory-${String(index).padStart(2, '0')}-${arm}`
      const raw = load(`${directory}/chromium-memory.json`)
      const {samples, ...summary} = raw
      const {index: _index, arm: _arm, ...recorded} = observation
      assert.deepEqual(recorded, summary)
      assert.equal(raw.authoritativeTiming, false)
      assert.equal(raw.benchmarkExitCode, 0)
      assert.equal(raw.sampleCount, samples.length)
      const covered = samples.filter((value) => value.processes.length > 0 && value.unavailablePids.length === 0 && value.stableObservedProcessSet)
      assert.ok(covered.length > 0)
      assert.equal(raw.stableFullyReadSampleCount, covered.length)
      assert.equal(raw.maxSampledPssKiB, Math.max(...covered.map((value) => value.pssKiB)))
      assert.equal(raw.maxSampledPrivateKiB, Math.max(...covered.map((value) => value.privateKiB)))
      for (const sample of samples) {
        assert.equal(sample.pssKiB, sample.processes.reduce((sum, value) => sum + value.pssKiB, 0))
        assert.equal(sample.privateKiB, sample.processes.reduce((sum, value) => sum + value.privateKiB, 0))
        const count = String(sample.discoveredPids.length)
        memoryCoverage.discoveredPidCountHistogram[count] = (memoryCoverage.discoveredPidCountHistogram[count] ?? 0) + 1
      }
      memoryCoverage.samples += samples.length
      ++memoryCoverage.runs
      memoryReceipts.push({index, arm, samples: rawIdentity(`${directory}/chromium-memory.json`), ...verifyRun(directory, arm)})
    }
    cells.push({runId: campaign.id, harness: campaign.head, dictionary, replication, jobId: job.id, jobConclusion: job.conclusion,
      artifactId: advertised.id, artifactZipSha256: receipt.verifiedZipSha256, artifactZipBytes: receipt.verifiedZipBytes,
      artifactManifestSha256: sha(readFileSync(path.join(cellRoot, 'artifact-manifest.json'))), plan: rawIdentity('plan.json'),
      originalQualificationPassed: originalGuardPass, statisticsScope: originalGuardPass ? 'fixed-pair timing with the original campaign guards passed; assess effect against controls' : 'descriptive only; the original physical counter guard failed and remains failed',
      resultsPresent, semanticDigestSha256: [...semanticDigests][0], physicalDigests, layoutDifferences, derivedDifferences,
      packageDifferences, packageSha256: Object.fromEntries(['A', 'B'].map((arm) => [arm, identities[arm].packageSha256])), browserVersions: [...browserVersions],
      pairs, observations: observationReceipts, memoryObservations: memoryReceipts})
  }
}

const groups = []
for (const campaign of campaigns) for (const dictionary of campaign.dictionaries) {
  const selected = cells.filter((value) => value.runId === campaign.id && value.dictionary === dictionary)
  assert.equal(selected.length, 2)
  const collect = (kind) => selected.flatMap((cell) => cell.pairs[kind].pairs.map((pair) => ({replication: cell.replication, ...pair})))
  groups.push({runId: campaign.id, dictionary, originalQualificationPassed: selected.every((value) => value.originalQualificationPassed),
    candidate: summarize(collect('candidate')), controls: summarize(collect('controls-all'))})
}
const receipt = {
  schemaVersion: 1, status: 'independent-read-only-audit-passed', baseline, candidate,
  perArmPackagedFilesIdenticalAcrossAllEightCells: true, timingHarnessIdenticalAcrossCorrectiveAndFinalCampaigns: true,
  observationCount: cells.reduce((sum, value) => sum + value.observations.length, 0),
  preAndPostRestartStatesCheckedIncludingMemory: checkedStates, checkedPhysicalCounters, checkedPhysicalRows,
  sampledSemanticScope: 'Complete exact-lookup responses for 12 deterministic terms per dictionary, every observation before and after restart; not exhaustive all-term browser readback.',
  originalFailuresPreserved: cells.filter((value) => !value.originalQualificationPassed).map(({runId, dictionary, replication}) => ({runId, dictionary, replication})),
  memoryCoverage,
  memoryLimitation: 'Original argv[0] executable-name filtering did not establish Chromium renderer/import-worker coverage. Raw diagnostics are preserved and excluded from timing; no whole-tree peak or memory nonregression claim is supported.',
  physicalReadbackLimit: 'Raw previews inspect encoded reference storage, not decoded glossary content. Derived preview counters are recomputed from every retained row. Direct persisted file lengths were not retained; no inferred size is presented as a direct stat.',
  groups, cells,
}
const encoded = `${JSON.stringify(receipt, null, 2)}\n`
if (output) writeFileSync(output, encoded, {flag: 'wx'})
else process.stdout.write(encoded)
if (output) console.log(JSON.stringify({output, observations: receipt.observationCount, checkedStates, checkedPhysicalCounters, checkedPhysicalRows,
  groups: groups.map(({runId, dictionary, originalQualificationPassed, candidate: value, controls}) => ({runId, dictionary, originalQualificationPassed, medianChangePercent: value.medianChangePercent, fasterPairs: value.fasterPairs, controlsRange: [controls.minChangePercent, controls.maxChangePercent]})), memoryCoverage}, null, 2))
