import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync, readdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {installRecordFieldExport} from './export-hook.mjs'
import {readCapturedCall, reconstructPrivateCall} from './captured-inputs.mjs'
import {NativeRecordFields} from './native-wrapper.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const sourceRoot = resolve(here, '../../manabitan')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const binding = JSON.parse(readFileSync(resolve(here, 'capture-binding.json')))
for (const [name, digest] of Object.entries(binding.files)) assert.equal(sha256(readFileSync(resolve(here, name))), digest, name)
const runtime = JSON.parse(readFileSync(resolve(here, 'runtime-identity.json')))
for (const [name, digest] of Object.entries(runtime.files)) assert.equal(sha256(readFileSync(resolve(sourceRoot, name))), digest, name)
const capture = JSON.parse(readFileSync(resolve(here, 'run/record-field-calls.json')))
const importReport = JSON.parse(readFileSync(resolve(here, 'run/report.json')))
assert.equal(capture.complete, true)
assert.equal(capture.stockOutputsConsumed, true)
assert.equal(importReport.retainedBaselineHashParity, true)
assert.equal(capture.calls.length, 12)
const hook = installRecordFieldExport(sourceRoot, binding.recordEncoderSha256)
const current = await import(pathToFileURL(resolve(sourceRoot, binding.recordEncoderSource)).href)
hook.finish()
const stock = (chunk, offsets, lengths, base) => current.TermRecordOpfsStore.prototype._encodeArtifactRecordFields.call(null, chunk, offsets, lengths, base)
const wasmBytes = readFileSync(resolve(here, 'record-fields.wasm'))
const helper = new NativeRecordFields({wasmBytes, privateReferences: current.diagnosticRecordFieldReferences, stockEncode: stock})
assert.equal(helper.initializationError, null)
const attempts = resolve(here, 'parity-attempts')
mkdirSync(attempts, {recursive: true})
const attempt = resolve(attempts, String(readdirSync(attempts).length + 1).padStart(3, '0'))
mkdirSync(attempt)
const sourceNames = ['record-fields.c', 'record-fields.wasm', 'native-wrapper.mjs', 'captured-inputs.mjs', 'replay-captured.mjs', 'capture-binding.json', 'run/record-field-calls.json', 'run/report.json', 'test-attempts/002/report.json']
const sourceHashes = Object.fromEntries(sourceNames.map((name) => [name, sha256(readFileSync(resolve(here, name)))]))
const results = []
const heldOutputs = []
const beforeSourceHashes = (columns) => Object.fromEntries(Object.entries(columns).map(([name, value]) => [name, sha256(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))]))
for (const receipt of capture.calls) {
    const result = {number: receipt.number, groupIndex: receipt.groupIndex, rows: receipt.rowCount, pass: false}
    results.push(result)
    try {
        assert.equal(receipt.number, results.length - 1)
        assert.equal(receipt.groupIndex, receipt.number)
        const captured = readCapturedCall(resolve(here, 'run'), receipt)
        const input = reconstructPrivateCall(captured, current.createArtifactTermRecordChunkWithResolvedContent)
        assert(current.diagnosticRecordFieldReferences(input.chunk, input.chunk.rowCount) !== null)
        const before = beforeSourceHashes(captured.columns)
        const stockBytes = stock(input.chunk, input.contentOffsets, input.contentLengths, input.base)
        assert.deepEqual(stockBytes, input.expected, 'Fresh untouched stock encoder matches every captured original output byte')
        const nativeBytes = helper.encode(input.chunk, input.contentOffsets, input.contentLengths, input.base)
        result.stats = {...helper.lastStats}
        assert.equal(helper.lastStats.native, true, JSON.stringify(helper.lastStats))
        assert.deepEqual(nativeBytes, input.expected, 'Native complete output is byte-identical to the actual consumed stock output')
        assert.deepEqual(beforeSourceHashes(captured.columns), before, 'Every input column remains untouched')
        assert.notEqual(nativeBytes.buffer, helper.memory.buffer)
        assert.notEqual(nativeBytes.buffer, stockBytes.buffer)
        const expectedOrder = [...new Set(captured.columns.scores.subarray(0, receipt.rowCount))]
        const header = new Uint32Array(nativeBytes.buffer, 0, 4)
        assert.equal(header[2], expectedOrder.length)
        assert.deepEqual([...new Int32Array(nativeBytes.buffer, 16, header[2])], expectedOrder)
        assert.equal(helper.lastStats.inputCopiedBytes, receipt.rowCount * 8 + captured.columns.resolvedOffsets.length * 12)
        assert.equal(helper.lastStats.outputCopiedBytes, nativeBytes.byteLength)
        result.outputBytes = nativeBytes.byteLength
        result.outputSha256 = sha256(nativeBytes)
        heldOutputs.push({bytes: nativeBytes, sha256: result.outputSha256})
        result.pass = true
    } catch (error) {
        result.error = String(error)
        result.stack = error.stack
    }
    writeFileSync(resolve(attempt, 'report.json'), JSON.stringify({complete: false, timingAcquisition: false, sourceHashes, results}, null, 2) + '\n')
}
for (const output of heldOutputs) assert.equal(sha256(output.bytes), output.sha256, 'Later helper reuse and growth cannot change an earlier owning result')
const sumFields = ['rows', 'uniqueRows', 'inputCopiedBytes', 'inputCopyCalls', 'outputCopiedBytes', 'tableZeroedBytes', 'scratchBytes', 'memoryGrowthBytes', 'nativeDictionaryCopiedBytes', 'nativeKeysCopiedBytes', 'scoreCount']
const totals = Object.fromEntries(sumFields.map((key) => [key, results.reduce((sum, result) => sum + (result.stats?.[key] ?? 0), 0)]))
totals.maximumScratchBytes = Math.max(...results.map((result) => result.stats?.scratchBytes ?? 0))
totals.maximumLinearMemoryBytes = helper.memory.buffer.byteLength
totals.initialLinearMemoryBytes = 131072
totals.nativeCalls = results.filter((result) => result.stats?.native).length
totals.fallbackCalls = results.filter((result) => result.stats && !result.stats.native).length
totals.totalInputAndOutputCopyBytes = totals.inputCopiedBytes + totals.outputCopiedBytes
const report = {complete: true, timingAcquisition: false, node: process.version, baseline: binding.baseline, sourceHashes, actualSinkCalls: capture.calls.length, rows: capture.calls.reduce((sum, call) => sum + call.rowCount, 0), passed: results.filter((result) => result.pass).length, failed: results.filter((result) => !result.pass).length, allConsumedStockOutputsReproduced: results.every((result) => result.pass), completeFinalizedStockImportParity: true, totals, results}
writeFileSync(resolve(attempt, 'report.json'), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify({complete: true, passed: report.passed, failed: report.failed, rows: report.rows, totals}))
if (report.failed) process.exitCode = 1
