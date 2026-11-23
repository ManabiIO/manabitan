import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {extractImportResult} from '../benchmark-support.js'
import {verifyReadback, overlayFiles, timingFiles} from '../import-study-20261123/verify.mjs'

const hash = (data) => createHash('sha256').update(data).digest('hex')
const integer = (value) => Number.isSafeInteger(value) && value >= 0
const one = (events, type, realm) => {
  const found = events.filter((event) => event.type === type && (!realm || event.realm === realm))
  assert.equal(found.length, 1, `Expected one ${realm ?? ''} ${type}`)
  return found[0]
}

export function verifyReceipt(receipt, arm, metrics, fixture) {
  assert.equal(receipt.schemaVersion, 1)
  assert.equal(receipt.arm, arm)
  assert.equal(receipt.purpose, 'mechanistic-diagnostic-only')
  assert.ok(Array.isArray(receipt.events) && receipt.events.length > 0)
  const {events} = receipt
  const realms = new Map()
  const known = new Set(['session-begin', 'session-complete', 'worker-prewarm', 'worker-start', 'worker-startup',
    'worker-ready', 'worker-readiness-wait', 'file-handle', 'writer-open', 'batch-enqueue', 'batch-start',
    'batch-complete', 'request-send', 'request-ack', 'request-received', 'request-complete', 'request-failed',
    'writer-flush', 'writer-close', 'worker-dispose', 'worker-retire'])
  for (const event of events) {
    assert.ok(known.has(event.type), `Unknown event ${event.type}`)
    assert.ok(['record-store', 'index-worker'].includes(event.realm))
    assert.ok(integer(event.sequence) && event.sequence > 0)
    assert.ok([event.startMs, event.endMs, event.timeOriginMs].every(Number.isFinite))
    assert.ok(event.startMs >= 0 && event.endMs >= event.startMs && event.timeOriginMs > 0)
    assert.notEqual(event.success, false, `${event.type} reported failure`)
    assert.notEqual(event.type, 'request-failed')
    const previous = realms.get(event.realm)
    assert.equal(event.sequence, previous ? previous.sequence + 1 : 1, 'Missing, repeated or reordered realm event')
    if (previous) {
      assert.equal(event.timeOriginMs, previous.timeOriginMs)
      assert.ok(event.endMs >= previous.endMs, 'Realm monotonic completion order changed')
    }
    realms.set(event.realm, event)
  }
  const begin = one(events, 'session-begin', 'record-store')
  assert.equal(begin.rawTermBankSourceBytes, 171617523)
  const terminal = one(events, 'session-complete', 'record-store')
  assert.equal(realms.get('record-store'), terminal)
  assert.equal(terminal.success, true)
  assert.equal(terminal.writeCallCount, 5)
  assert.equal(terminal.writeBytes, 23748912)
  assert.equal(terminal.workerFileCount, arm === 'A' ? 0 : 1)
  assert.equal(metrics.termRecordLookupIndexWriteCallCount, terminal.writeCallCount)
  assert.equal(metrics.termRecordLookupIndexWriteBytes, terminal.writeBytes)
  assert.equal(metrics.termRecordLookupIndexWorkerFileCount, terminal.workerFileCount)
  const batches = events.filter((event) => event.type === 'batch-enqueue')
  assert.equal(batches.length, 5)
  assert.equal(new Set(batches.map((event) => event.batchId)).size, 5)
  assert.equal(batches.reduce((sum, event) => sum + event.byteLength, 0), terminal.writeBytes)
  assert.equal(batches.reduce((sum, event) => sum + event.recordCount, 0), fixture.termRows)
  const fileNames = new Set(batches.map((event) => event.fileName))
  assert.equal(fileNames.size, 1)
  const [fileName] = fileNames
  assert.ok(fileName.endsWith('.mbti'))
  for (const batch of batches) {
    assert.equal(batch.realm, 'record-store')
    assert.ok(integer(batch.batchId) && batch.batchId > 0)
    assert.ok(integer(batch.byteLength) && batch.byteLength > 0)
    assert.ok(integer(batch.chunkCount) && batch.chunkCount > 0)
    assert.ok(integer(batch.recordCount) && batch.recordCount > 0)
    assert.ok(integer(batch.queuedBytes) && batch.queuedBytes >= batch.byteLength)
    const selected = events.filter((event) => event.batchId === batch.batchId)
    const start = one(selected, 'batch-start', 'record-store')
    const complete = one(selected, 'batch-complete', 'record-store')
    assert.equal(complete.success, true)
    for (const field of ['batchId', 'fileName', 'byteLength', 'chunkCount', 'recordCount']) {
      assert.equal(start[field], batch[field])
      assert.equal(complete[field], batch[field])
    }
    assert.ok(start.startMs >= batch.startMs && complete.endMs >= start.endMs)
  }
  const file = one(events, 'file-handle', 'record-store')
  assert.equal(file.fileName, fileName)
  assert.equal(file.success, true)
  const realm = arm === 'A' ? 'record-store' : 'index-worker'
  const opened = one(events, 'writer-open', realm)
  assert.equal(opened.status, 'opened')
  assert.equal(opened.fileName, fileName)
  assert.equal(opened.periodicFlush, arm !== 'A')
  const closed = one(events, 'writer-close', realm)
  assert.equal(closed.writerId, opened.writerId)
  assert.equal(closed.fileName, fileName)
  assert.equal(closed.aborted, false)
  assert.equal(closed.success, true)
  assert.equal(closed.position, 40)
  assert.equal(closed.fileLength, 23748952)
  assert.equal(closed.writtenBytes, 23748992)
  const flushes = events.filter((event) => event.type === 'writer-flush')
  assert.equal(flushes.length, arm === 'A' ? 1 : 2)
  const final = one(flushes.filter((event) => event.reason === 'final'), 'writer-flush', realm)
  const periodic = flushes.filter((event) => event.reason === 'periodic')
  assert.equal(periodic.length, arm === 'A' ? 0 : 1)
  for (const flush of flushes) {
    assert.equal(flush.success, true)
    assert.equal(flush.periodicFlush, arm !== 'A')
    assert.equal(flush.writerId, opened.writerId)
    assert.equal(flush.fileName, fileName)
    assert.ok(flush.sequence < closed.sequence)
  }
  for (const key of ['position', 'fileLength', 'writtenBytes']) assert.equal(final[key], closed[key])
  if (periodic.length) {
    const value = periodic[0]
    assert.ok(value.writtenBytes >= 16777216 && value.writtenBytes < 16777216 + 524288)
    for (const key of ['position', 'fileLength', 'unflushedBytes']) assert.equal(value[key], value.writtenBytes)
    assert.equal(final.unflushedBytes, closed.writtenBytes - value.writtenBytes)
    assert.ok(value.sequence < final.sequence)
  } else assert.equal(final.unflushedBytes, closed.writtenBytes)
  const sends = events.filter((event) => event.type === 'request-send')
  if (arm === 'A') {
    assert.equal(realms.size, 1)
    assert.equal(sends.length, 0)
    assert.equal(events.filter((event) => event.type.startsWith('worker-')).length, 0)
  } else {
    assert.equal(realms.size, 2)
    assert.equal(one(events, 'worker-startup', 'record-store').status, 'ready')
    one(events, 'worker-start', 'record-store')
    one(events, 'worker-ready', 'record-store')
    one(events, 'worker-ready', 'index-worker')
    assert.equal(one(events, 'worker-readiness-wait', 'record-store').available, true)
    one(events, 'worker-dispose', 'record-store')
    one(events, 'worker-retire', 'record-store')
    const workerStart = one(events, 'worker-start', 'record-store')
    if (arm === 'B') assert.ok(workerStart.sequence > file.sequence, 'Lazy worker started before first file handle')
    if (arm === 'C') {
      const prewarm = one(events, 'worker-prewarm', 'record-store')
      assert.ok(prewarm.sequence < workerStart.sequence && workerStart.sequence < batches[0].sequence)
    }
    assert.ok(sends.length > 0)
    assert.equal(new Set(sends.map((event) => event.requestId)).size, sends.length)
    for (const type of ['request-ack', 'request-received', 'request-complete']) {
      assert.equal(events.filter((event) => event.type === type).length, sends.length)
    }
    for (const send of sends) {
      assert.ok(integer(send.requestId) && send.requestId > 0)
      assert.ok(integer(send.byteLength) && integer(send.chunkCount))
      assert.equal(send.writerId, opened.writerId)
      const selected = events.filter((event) => event.requestId === send.requestId)
      const received = one(selected, 'request-received', 'index-worker')
      const complete = one(selected, 'request-complete', 'index-worker')
      const ack = one(selected, 'request-ack', 'record-store')
      for (const event of [received, complete, ack]) {
        assert.equal(event.writerId, send.writerId)
        assert.equal(event.action, send.action)
        assert.equal(event.batchId, send.batchId)
      }
      assert.equal(complete.success, true)
      assert.equal(ack.success, true)
      assert.equal(ack.byteLength, send.byteLength)
      assert.equal(ack.chunkCount, send.chunkCount)
      assert.ok(ack.endMs >= send.endMs && complete.endMs >= received.endMs)
    }
    assert.equal(sends.filter((event) => event.action === 'open').length, 1)
    assert.ok(sends.find((event) => event.action === 'open').sequence > file.sequence, 'Writer opened before normal file admission')
    assert.equal(sends.filter((event) => event.action === 'close').length, 1)
    const writes = sends.filter((event) => event.action === 'writeChunks')
    assert.equal(writes.reduce((sum, event) => sum + event.byteLength, 0), closed.writtenBytes)
    for (const batch of batches) {
      const write = writes.filter((event) => event.batchId === batch.batchId)
      assert.equal(write.length, 1)
      assert.equal(write[0].byteLength, batch.byteLength)
      assert.equal(write[0].chunkCount, batch.chunkCount)
    }
  }
  assert.equal(events.filter((event) => event.type === 'worker-prewarm').length, arm === 'C' ? 1 : 0)
  return {eventCount: events.length, requestCount: sends.length, batchCount: batches.length,
    writeBytes: terminal.writeBytes, fileLength: closed.fileLength, physicalWrittenBytes: closed.writtenBytes,
    workerFileCount: terminal.workerFileCount,
    flushes: flushes.map((event) => ({realm: event.realm, reason: event.reason, durationMs: event.endMs - event.startMs,
      position: event.position, fileLength: event.fileLength, writtenBytes: event.writtenBytes, unflushedBytes: event.unflushedBytes}))}
}

export function verifyDiagnostic(directory) {
  const load = (name) => JSON.parse(readFileSync(path.join(directory, name), 'utf8'))
  const plan = load('plan.json')
  assert.equal(plan.authoritativeTiming, false)
  assert.equal(plan.noWarmupExclusions, true)
  assert.equal(plan.noRetries, true)
  assert.equal(plan.nodeVersion, 'v22.22.0')
  assert.equal(plan.dictionary, 'jmdict')
  assert.deepEqual(plan.schedule, ['ABC', 'CBA'].flatMap((arms, index) => [...arms].map((arm) => ({name: `${arm}${index + 1}`, arm, triplet: index + 1}))))
  assert.equal(plan.config.authoritativeTiming, false)
  for (const [name, digest] of Object.entries(plan.sourceFiles)) assert.equal(hash(readFileSync(path.join(directory, 'source', name))), digest)
  assert.deepEqual(load('source/dev/perf/jmdict-index-io-diagnostic-20261123/config.json'), plan.config)
  assert.deepEqual(load('source/test/perf/dictionaries.lock.json').dictionaries.jmdict, plan.fixture)
  const identities = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, load(`${arm}-identity.json`)]))
  const packages = Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, load(`${arm}-package-entries.json`)]))
  const differences = Object.fromEntries(['B', 'C'].map((arm) => [arm,
    [...new Set([...Object.keys(packages.A), ...Object.keys(packages[arm])])].filter((name) => packages.A[name] !== packages[arm][name]).sort()]))
  for (const value of Object.values(differences)) assert.deepEqual(value, plan.config.expectedArmPackageDifferences)
  assert.deepEqual(differences, load('package-differences.json'))
  const media = load('media-reference.json')
  let semantics = null
  let physical = null
  let browser = null
  const observations = []
  for (const observation of plan.schedule) {
    const {arm, name} = observation
    const summary = load(`${name}/summary.json`)
    const report = load(`${name}/run-1.json`)
    const acquired = load(`${name}/acquisition.json`)
    const identity = identities[arm]
    assert.equal(identity.sha, plan.config.arms[arm].sha)
    assert.equal(identity.tree, plan.config.arms[arm].tree)
    assert.equal(summary.gitSha, identity.sha)
    assert.equal(summary.source.gitSha, identity.sha)
    assert.equal(summary.source.sha256['builds/manabitan-chrome.zip'], identity.packageSha256)
    assert.equal(report.packageSha256, identity.packageSha256)
    assert.equal(summary.runs.length, 1)
    assert.equal(summary.traceEnabled, false)
    assert.equal(summary.importFlags, null)
    assert.equal(summary.mediaCheck, 'all')
    for (const file of [...overlayFiles, ...timingFiles].filter((file) => file !== 'ext/js/core/safe-performance.js')) {
      assert.equal(summary.source.sha256[file], plan.sourceFiles[file])
    }
    const run = summary.runs[0]
    const recomputed = extractImportResult(report, 'jmdict', plan.fixture, false, null, 'all')
    assert.deepEqual(Object.fromEntries(Object.keys(recomputed).map((key) => [key, run[key]])), recomputed)
    verifyReadback(run.validation, report.benchmark, 'jmdict', plan.fixture, media)
    semantics ??= run.validation.semanticProbes
    physical ??= run.validation.physicalProbes
    browser ??= report.browserVersion
    assert.deepEqual(run.validation.semanticProbes, semantics)
    assert.deepEqual(run.validation.physicalProbes, physical)
    assert.equal(report.browserVersion, browser)
    for (const key of ['name', 'arm', 'triplet']) assert.equal(acquired[key], observation[key])
    assert.equal(acquired.retried, false)
    assert.equal(acquired.authoritativeTiming, false)
    for (const host of ['host-before', 'host-after']) assert.equal(load(`${name}/${host}.json`).nodeVersion, 'v22.22.0')
    const finalization = run.importDebug.importerPhaseTimings.filter((phase) => phase.phase === 'bulk-finalization')
    assert.equal(finalization.length, 1)
    const metrics = finalization[0].details
    const receipt = metrics.termRecordLookupIndexIoDiagnostic
    const invariants = verifyReceipt(receipt, arm, metrics, plan.fixture)
    observations.push({...observation, diagnosticImportMs: run.totalImportMs,
      finalRecordCloseMs: metrics.termRecordEndImportSessionCloseWritableMs,
      finalIndexAwaitMs: metrics.termRecordLookupIndexAwaitMs, invariants, receipt})
  }
  return {schemaVersion: 1, authoritativeTiming: false, scope: plan.scope,
    baseline: plan.config.baseline, arms: plan.config.arms, browserVersion: browser,
    schedule: plan.schedule, observations, semanticDigestSha256: hash(JSON.stringify(semantics)),
    limitation: 'Instrumented mechanism diagnosis only; all six observations retained. No production speedup, memory or synchronized cross-realm clock claim.'}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyDiagnostic(process.argv[2])
  writeFileSync(path.join(process.argv[2], 'result.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify(result))
}
