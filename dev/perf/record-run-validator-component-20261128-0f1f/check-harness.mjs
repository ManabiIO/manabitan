// Fake implementations and clock: protocol checks only, no native compilation or timing.
import assert from 'node:assert/strict'
import {webcrypto} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import {hash, toolingRoot} from './common.mjs'

const source = await readFile(path.join(toolingRoot, 'worker.mjs'), 'utf8')
const imports = ["import {baselineScan} from './baseline-loop.mjs'\n", "import {NativeRecordRunValidator} from './native-validator.mjs'\n"]
let executable = source
for (const line of imports) {
    assert(executable.includes(line))
    executable = executable.replace(line, '')
}
const moduleBytes = Uint8Array.of(10, 20, 30, 40)
const payload = new Uint8Array(20)
new Float64Array(payload.buffer, 8, 1)[0] = 16
new Uint32Array(payload.buffer, 16, 1)[0] = 7
const columns = {
    uniqueIndexList: {offset: 0, bytes: 8, length: 2, sha256: hash(payload.subarray(0, 8))},
    offsets: {offset: 8, bytes: 8, length: 1, sha256: hash(payload.subarray(8, 16))},
    lengths: {offset: 16, bytes: 4, length: 1, sha256: hash(payload.subarray(16, 20))},
}
const groups = Array.from({length: 12}, (_, index) => ({
    group: index + 1, rowCount: 2, uniqueCount: 1, bytes: 20, sha256: hash(payload), columns,
    inputCopyBytes: 20, expected: {runEnd: 2, minimum: 16, maximum: 16},
}))
async function check(mode, arm) {
    const messages = []
    let validationCalls = 0
    let initCalls = 0
    let clockReads = 0
    let inputFetches = 0
    let finish
    const done = new Promise((resolve) => { finish = resolve })
    const validate = (refs) => {
        validationCalls++
        if (mode === 'native-trap') throw new Error('synthetic native failure')
        if (mode === 'input-write') refs.lengths[0] = 8
        return {runEnd: mode === 'bad-return' ? 1 : 2, minimum: 16, maximum: 16}
    }
    const context = {
        ArrayBuffer, Uint8Array, Uint16Array, Uint32Array, Float64Array,
        crypto: webcrypto, performance: {timeOrigin: 0, now: () => ++clockReads},
        navigator: {userAgent: 'synthetic protocol check', hardwareConcurrency: 4, deviceMemory: 8},
        crossOriginIsolated: mode !== 'isolation-mismatch', self: {},
        baselineScan: validate,
        NativeRecordRunValidator: class {
            constructor(bytes) {
                assert.equal(hash(new Uint8Array(bytes)), hash(moduleBytes))
                initCalls++
                if (mode === 'initialization-failure') throw new Error('synthetic initialization failure')
                this.metrics = {initializationMs: 0, moduleCompileMs: 0, memoryAndInstantiateMs: 0,
                    calls: 0, fallbackCalls: 0, copyInputBytes: 0, growMs: 0, copyMs: 0,
                    kernelMs: 0, guardAndResultMs: 0, peakHeapBytes: 65536}
            }
            validate(refs) {
                if (mode === 'unexpected-fallback') {
                    validationCalls++
                    this.metrics.fallbackCalls++
                    return null
                }
                const result = validate(refs)
                this.metrics.calls++
                this.metrics.copyInputBytes += mode === 'copy-counter-drift' ? 19 : 20
                this.metrics.kernelMs++
                return result
            }
        },
        fetch: async (url) => {
            const copy = new Uint8Array(url.endsWith('.wasm') ? moduleBytes : payload)
            if (!url.endsWith('.wasm')) {
                inputFetches++
                if (mode === 'late-input-drift' && inputFetches === 13) copy[0] = 1
            }
            return {ok: true, status: 200, arrayBuffer: async () => copy.buffer}
        },
        postMessage: (message) => {
            messages.push(JSON.parse(JSON.stringify(message)))
            if (message.type === 'call') {
                queueMicrotask(() => context.self.onmessage({data: {type: 'ack', pass: message.call.pass,
                    group: message.call.group + (mode === 'wrong-ack' ? 1 : 0)}}))
            } else finish(message)
        },
    }
    vm.runInNewContext(executable, context, {filename: 'worker.mjs'})
    context.self.onmessage({data: {type: 'start', arm, kernel: {sha256: hash(moduleBytes)}, groups, passes: 2,
        worker: {crossOriginIsolated: true}, checks: {nativeCallsPerPass: 12,
            nativeCopiedInputBytesPerPass: 240, expectedNativePeakHeapBytes: 65536}}})
    const terminal = await done
    const calls = messages.filter(({type}) => type === 'call').map(({call}) => call)
    assert(calls.every(({elapsedMs}) => elapsedMs === 1))
    if (mode === 'success') {
        assert.equal(terminal.type, 'complete')
        assert.equal(validationCalls, 24)
        assert.equal(calls.length, 24)
        assert.equal(initCalls, arm === 'B' ? 1 : 0)
        assert.deepEqual(calls.map(({pass, group}) => [pass, group]), [1, 2].flatMap((pass) => groups.map(({group}) => [pass, group])))
        assert(calls.every((c) => c.resultEqual && c.inputsUnchanged))
        if (arm === 'B') assert(calls.every((c) => c.phase.calls === 1 && c.phase.copyInputBytes === 20))
        else assert(calls.every((c) => c.phase === null && c.nativeInitializationElapsedMs === 0))
    } else {
        assert.equal(terminal.type, 'failed')
        const beforeCallFailure = ['isolation-mismatch', 'initialization-failure'].includes(mode)
        assert.equal(calls.length, mode === 'late-input-drift' ? 12 : beforeCallFailure ? 0 : 1)
        if (mode === 'late-input-drift') assert.equal(validationCalls, 12)
        if (mode === 'initialization-failure') assert.equal(validationCalls, 0)
        if (mode === 'isolation-mismatch') assert.equal(initCalls, 0)
        if (mode === 'input-write') assert.equal(calls[0].inputsUnchanged, false)
        if (mode === 'bad-return' || mode === 'unexpected-fallback') assert.equal(calls[0].resultEqual, false)
        if (mode === 'native-trap') assert.match(calls[0].error, /synthetic native failure/)
        if (mode === 'copy-counter-drift') assert.equal(calls[0].phase.copyInputBytes, 19)
        if (mode === 'wrong-ack') assert.match(terminal.error, /Out-of-order acknowledgement/)
    }
    return {mode, arm, terminal: terminal.type, retainedCalls: calls.length, validationCalls, initCalls, fakeClockReads: clockReads}
}
const checks = [await check('success', 'A'), await check('success', 'B')]
for (const mode of ['late-input-drift', 'input-write', 'bad-return', 'native-trap', 'unexpected-fallback',
    'copy-counter-drift', 'wrong-ack', 'isolation-mismatch', 'initialization-failure']) checks.push(await check(mode, 'B'))
console.log(JSON.stringify({scope: 'Synthetic worker sequencing/failure checks, fake clock and fake validator; no performance measurements',
    workerSha256: hash(source), checks}, null, 2))
