import assert from 'node:assert/strict'
import test from 'node:test'
import {verifyReceipt} from './verify.mjs'

function makeReceipt(arm) {
  const receipt = {schemaVersion: 1, arm, purpose: 'mechanistic-diagnostic-only', events: []}
  const seq = {'record-store': 0, 'index-worker': 0}
  const clock = {'record-store': 1, 'index-worker': 1}
  const fileName = 'dictionary-1.mbti'
  const writerId = arm === 'A' ? 'local-2' : 'worker-1'
  const periodic = arm !== 'A'
  let requestId = 0
  function emit(realm, type, details = {}) {
    const time = clock[realm]++
    const event = {...details, sequence: ++seq[realm], realm, type, startMs: time, endMs: time + 0.25,
      timeOriginMs: realm === 'record-store' ? 1000 : 1010}
    receipt.events.push(event)
    return event
  }
  const root = (type, details) => emit('record-store', type, details)
  const worker = (type, details) => emit('index-worker', type, details)
  const writer = periodic ? worker : root
  function startWorker() {
    root('worker-start')
    worker('worker-ready')
    root('worker-ready')
    root('worker-startup', {status: 'ready'})
  }
  function request(action, byteLength, chunkCount, batchId, body = () => {}) {
    const details = {requestId: ++requestId, writerId, action, batchId}
    root('request-send', {...details, byteLength, chunkCount})
    worker('request-received', details)
    body()
    worker('request-complete', {...details, success: true})
    root('request-ack', {...details, byteLength, chunkCount, success: true})
  }
  const flush = (reason) => writer('writer-flush', {writerId, fileName, reason, success: true, periodicFlush: periodic,
    position: reason === 'final' ? 40 : 16800000,
    fileLength: reason === 'final' ? 23748952 : 16800000,
    writtenBytes: reason === 'final' ? 23748992 : 16800000,
    unflushedBytes: reason === 'periodic' ? 16800000 : 23748992 - (periodic ? 16800000 : 0)})
  root('session-begin', {rawTermBankSourceBytes: 171617523})
  if (arm === 'C') {
    root('worker-prewarm')
    startWorker()
  }
  for (let index = 0; index < 5; index++) {
    const batch = {batchId: index + 1, fileName, byteLength: index === 4 ? 4548912 : 4800000,
      chunkCount: 2, recordCount: index === 4 ? 128299 : 100000}
    root('batch-enqueue', {...batch, queuedBytes: batch.byteLength})
    root('batch-start', batch)
    if (index === 0) {
      root('file-handle', {fileName, success: true})
      if (arm === 'B') startWorker()
      const opened = () => writer('writer-open', {writerId, fileName, periodicFlush: periodic, status: 'opened'})
      if (periodic) {
        root('worker-readiness-wait', {fileName, available: true})
        request('open', 0, 0, 0, opened)
        request('writeChunks', 40, 1, 0)
      } else opened()
    }
    if (periodic) request('writeChunks', batch.byteLength, batch.chunkCount, batch.batchId, () => { if (index === 3) flush('periodic') })
    root('batch-complete', {...batch, success: true})
  }
  const close = () => {
    flush('final')
    writer('writer-close', {writerId, fileName, aborted: false, success: true, position: 40, fileLength: 23748952, writtenBytes: 23748992})
  }
  if (periodic) {
    request('seek', 0, 0, 0)
    request('writeChunks', 40, 1, 0)
    request('close', 0, 0, 0, close)
    root('worker-dispose')
    root('worker-retire')
  } else close()
  root('session-complete', {success: true, writeCallCount: 5, writeBytes: 23748912, workerFileCount: periodic ? 1 : 0})
  return receipt
}

const fixture = {termRows: 528299}
const metrics = (arm) => ({termRecordLookupIndexWriteCallCount: 5, termRecordLookupIndexWriteBytes: 23748912,
  termRecordLookupIndexWorkerFileCount: arm === 'A' ? 0 : 1})

for (const arm of ['A', 'B', 'C']) {
  test(`accepts complete ${arm} lifecycle with identical bytes and fixed flush policy`, () => {
    const value = verifyReceipt(makeReceipt(arm), arm, metrics(arm), fixture)
    assert.equal(value.writeBytes, 23748912)
    assert.equal(value.fileLength, 23748952)
    assert.equal(value.flushes.length, arm === 'A' ? 1 : 2)
  })
}

for (const [name, mutate] of [
  ['missing realm event', (r) => r.events.splice(3, 1)],
  ['wrong output bytes', (r) => { r.events.find((e) => e.type === 'writer-close').fileLength++ }],
  ['wrong payload accounting', (r) => { r.events.find((e) => e.type === 'batch-enqueue').byteLength++ }],
  ['unpaired acknowledgement', (r) => { r.events.find((e) => e.type === 'request-ack').requestId = 999 }],
  ['wrong batch join', (r) => { r.events.find((e) => e.type === 'request-complete' && e.batchId > 0).batchId++ }],
  ['failed native flush', (r) => { r.events.find((e) => e.type === 'writer-flush').success = false }],
  ['changed flush threshold', (r) => { r.events.find((e) => e.type === 'writer-flush').writtenBytes = 8000000 }],
  ['mixed realm clock origin', (r) => { r.events.find((e) => e.type === 'request-ack').timeOriginMs++ }],
  ['wrong terminal worker path', (r) => { r.events.find((e) => e.type === 'session-complete').workerFileCount = 0 }]
]) {
  test(`rejects ${name}`, () => {
    const receipt = makeReceipt('B')
    mutate(receipt)
    assert.throws(() => verifyReceipt(receipt, 'B', metrics('B'), fixture))
  })
}

test('does not accept C receipts as unmodified B', () => {
  assert.throws(() => verifyReceipt(makeReceipt('C'), 'B', metrics('B'), fixture))
})
