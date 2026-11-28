import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {getCompileCacheDir} from 'node:module'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {gzipSync} from 'node:zlib'
import {here, repository, plan, capture, captureDirectory, sha256, verifyPlan, verifySources} from './common.mjs'
import {installRecordFieldExport} from './export-hook.mjs'
import {readCapturedCall, reconstructPrivateCall} from './captured-inputs.mjs'

assert.equal(process.argv.length, 5)
const [arm, mode, outputDirectoryArgument] = process.argv.slice(2)
assert(['A', 'B', 'C'].includes(arm))
assert(['timed', 'untimed'].includes(mode))
const timed = mode === 'timed'
const outputDirectory = resolve(outputDirectoryArgument)
mkdirSync(outputDirectory)
const flags = {execArgv: process.execArgv, nodeOptionsPresent: Boolean(process.env.NODE_OPTIONS), nodeCompileCacheConfigured: Boolean(process.env.NODE_COMPILE_CACHE), nodeCompileCacheDisabled: process.env.NODE_DISABLE_COMPILE_CACHE === '1', activeCompileCacheDirectory: getCompileCacheDir() ?? null}
const receipt = {complete: false, arm, mode, pid: process.pid, node: process.version, flags, timing: null, outputReceipts: [], nativeStats: []}
const save = () => writeFileSync(resolve(outputDirectory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
const outputs = new Array(12)
const nativeStats = new Array(12)
try {
    verifyPlan()
    receipt.source = verifySources()
    if (timed) {
        assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Timing is hosted only')
        assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No repeated acquisition')
        assert.equal(process.version, plan.nodeVersion)
    }
    assert.deepEqual(flags.execArgv, [])
    assert.equal(flags.nodeOptionsPresent, false)
    assert.equal(flags.nodeCompileCacheConfigured, false)
    assert.equal(flags.nodeCompileCacheDisabled, true)
    assert.equal(flags.activeCompileCacheDirectory, null)
    receipt.affinity = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] ?? null
    const hook = installRecordFieldExport(repository, plan.recordEncoderSha256)
    const current = await import(pathToFileURL(resolve(repository, plan.recordEncoderSource)).href)
    hook.finish()
    receipt.diagnosticExport = hook.receipt
    const inputs = capture.calls.map((call) => reconstructPrivateCall(readCapturedCall(captureDirectory, call), current.createArtifactTermRecordChunkWithResolvedContent))
    const stock = (chunk, offsets, lengths, base) => current.TermRecordOpfsStore.prototype._encodeArtifactRecordFields.call(null, chunk, offsets, lengths, base)
    let helper = null
    let sequenceError
    let cpuBefore
    let wallBefore
    if (timed) {
        cpuBefore = process.cpuUsage()
        wallBefore = process.hrtime.bigint()
    }
    try {
        if (arm === 'B') {
            // The candidate module is neither imported nor evaluated before
            // this interval. Asset read, compilation and instantiation count.
            const {NativeRecordFields} = await import(pathToFileURL(resolve(here, 'native-wrapper.mjs')).href)
            const wasmBytes = readFileSync(resolve(here, 'record-fields.wasm'))
            helper = new NativeRecordFields({wasmBytes, privateReferences: current.diagnosticRecordFieldReferences, stockEncode: stock})
            for (let i = 0; i < inputs.length; ++i) {
                const input = inputs[i]
                outputs[i] = helper.encode(input.chunk, input.contentOffsets, input.contentLengths, input.base)
                nativeStats[i] = helper.lastStats
            }
        } else {
            for (let i = 0; i < inputs.length; ++i) {
                const input = inputs[i]
                outputs[i] = stock(input.chunk, input.contentOffsets, input.contentLengths, input.base)
                nativeStats[i] = null
            }
        }
    } catch (error) {
        sequenceError = error
    } finally {
        if (timed) {
            const wallAfter = process.hrtime.bigint()
            const cpuAfter = process.cpuUsage()
            receipt.timing = {cpuBefore, cpuAfter, cpuUserMicros: cpuAfter.user - cpuBefore.user, cpuSystemMicros: cpuAfter.system - cpuBefore.system, cpuMs: (cpuAfter.user - cpuBefore.user + cpuAfter.system - cpuBefore.system) / 1000, wallBeforeNs: wallBefore.toString(), wallAfterNs: wallAfter.toString(), wallMs: Number(wallAfter - wallBefore) / 1e6}
        }
    }
    receipt.nativeStats = nativeStats
    receipt.resourceUsageAfterSequence = timed ? process.resourceUsage() : null
    receipt.helperInitializationError = helper?.initializationError ?? null
    const digest = createHash('sha256')
    const verificationErrors = []
    for (let i = 0; i < inputs.length; ++i) {
        const expected = plan.expectedCalls[i]
        const actual = outputs[i]
        const item = {number: i, rows: expected.rows, completeBytesEqual: false}
        receipt.outputReceipts.push(item)
        try {
            assert(actual instanceof Uint8Array)
            item.bytes = actual.byteLength
            item.sha256 = sha256(actual)
            assert.equal(item.bytes, expected.outputBytes)
            assert.equal(item.sha256, expected.outputSha256)
            assert.deepEqual(actual, inputs[i].expected)
            const length = Buffer.alloc(4)
            length.writeUInt32LE(actual.byteLength)
            digest.update(length).update(actual)
            if (arm === 'B') {
                assert.deepEqual(nativeStats[i], expected.stats, 'Every activation/copy/scratch/growth statistic is frozen')
                assert.notEqual(actual.buffer, helper.memory.buffer)
            }
            item.completeBytesEqual = true
            item.retainedBytes = {directory: 'frozen-kit/evidence/stage1/run', file: capture.calls[i].file, segment: 'output'}
        } catch (error) {
            item.error = String(error)
            if (actual instanceof Uint8Array) {
                item.differentOutputFile = `output-${String(i).padStart(3, '0')}.bin.gz`
                writeFileSync(resolve(outputDirectory, item.differentOutputFile), gzipSync(actual))
            }
            verificationErrors.push(error)
        }
    }
    receipt.outputDigest = digest.digest('hex')
    save()
    if (sequenceError) throw sequenceError
    if (verificationErrors.length) throw new AggregateError(verificationErrors, 'Complete output/work verification failed')
    assert.equal(receipt.outputDigest, plan.expectedOutputDigest)
    if (arm === 'B') {
        assert.equal(helper.initializationError, null)
        assert.equal(helper.memory.buffer.byteLength, plan.expectedTotals.maximumLinearMemoryBytes)
    }
    receipt.complete = true
    save()
    console.log(JSON.stringify({complete: true, arm, mode, timing: receipt.timing, outputDigest: receipt.outputDigest}))
} catch (error) {
    receipt.error = String(error)
    receipt.stack = error.stack
    save()
    console.error(String(error))
    process.exitCode = 1
}
