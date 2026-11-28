import {baselineScan} from './baseline-loop.mjs'
import {NativeRecordRunValidator} from './native-validator.mjs'

const requireValue = (condition, message) => { if (!condition) throw new Error(message) }
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
async function fetchBytes(url) {
    const response = await fetch(url, {cache: 'no-store'})
    requireValue(response.ok, `Fetch failed: ${url} ${response.status}`)
    return response.arrayBuffer()
}
let acknowledgement = null
let started = false
let currentCall = null
let stage = 'waiting'
async function publishCall(call) {
    await new Promise((resolve, reject) => {
        acknowledgement = {pass: call.pass, group: call.group, resolve, reject}
        postMessage({type: 'call', call})
    })
}
async function run({arm, kernel: binding, groups, passes, worker: workerPolicy, checks}) {
    requireValue(arm === 'A' || arm === 'B', 'Unexpected arm')
    requireValue(passes === 2 && groups.length === 12, 'Unexpected acquisition shape')
    requireValue(workerPolicy.crossOriginIsolated === true && crossOriginIsolated === true, 'Isolated worker timer policy mismatch')
    stage = 'module-bytes'
    const moduleBytes = await fetchBytes('/record-run-validator.wasm')
    requireValue(await sha256(moduleBytes) === binding.sha256, 'Module digest mismatch')
    let native = null
    let nativeInitializationElapsedMs = 0
    if (arm === 'B') {
        stage = 'initialization'
        const start = performance.now()
        native = new NativeRecordRunValidator(moduleBytes)
        nativeInitializationElapsedMs = performance.now() - start
        requireValue(Number.isFinite(nativeInitializationElapsedMs) && nativeInitializationElapsedMs >= 0, 'Invalid initialization interval')
    }
    const initialization = native === null ? null : {...native.metrics}
    let completedCalls = 0
    let previousCallEnd = null
    for (let pass = 1; pass <= passes; pass++) {
        for (const group of groups) {
            currentCall = {pass, group: group.group}
            stage = 'input'
            const payload = await fetchBytes(`/inputs/${group.group}`)
            requireValue(payload.byteLength === group.bytes, 'Input dimensions mismatch')
            requireValue(await sha256(payload) === group.sha256, 'Input payload digest mismatch')
            const refs = {}
            const constructors = {uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}
            for (const [key, column] of Object.entries(group.columns)) {
                // Restore independent private buffers, as represented in the sink capture.
                refs[key] = new constructors[key](payload.slice(column.offset, column.offset + column.bytes))
                requireValue(refs[key].length === column.length, 'Column dimensions mismatch')
                requireValue(await sha256(refs[key]) === column.sha256, 'Input column digest mismatch')
            }
            requireValue(refs.offsets.length <= group.rowCount, 'Unexpected structural fallback')
            const beforeMetrics = native === null ? null : {...native.metrics}
            stage = 'validate'
            let result = null
            let error = null
            const start = performance.now()
            try {
                result = native === null ? baselineScan(refs, 0, group.rowCount) : native.validate(refs, 0, group.rowCount)
            } catch (e) { error = String(e?.stack || e) }
            const end = performance.now()
            const elapsedMs = end - start
            const gapSincePriorCallMs = previousCallEnd === null ? null : start - previousCallEnd
            previousCallEnd = end
            stage = 'verify'
            let inputsUnchanged = true
            for (const [key, column] of Object.entries(group.columns)) {
                inputsUnchanged &&= await sha256(refs[key]) === column.sha256
            }
            const resultEqual = result !== null &&
                result.runEnd === group.expected.runEnd &&
                Object.is(result.minimum, group.expected.minimum) &&
                Object.is(result.maximum, group.expected.maximum)
            const phase = native === null ? null : Object.fromEntries(
                ['calls', 'fallbackCalls', 'copyInputBytes', 'growMs', 'copyMs', 'kernelMs', 'guardAndResultMs']
                    .map((key) => [key, native.metrics[key] - beforeMetrics[key]]),
            )
            const call = {pass, group: group.group, rowCount: group.rowCount, uniqueCount: group.uniqueCount,
                elapsedMs, gapSincePriorCallMs, result, expected: group.expected, resultEqual, inputsUnchanged,
                phase, heapBytes: native?.metrics.peakHeapBytes ?? 0,
                nativeInitializationElapsedMs, initialization}
            if (error !== null) call.error = error
            await publishCall(call)
            requireValue(error === null, error)
            requireValue(resultEqual && inputsUnchanged, 'Validation or input parity failure')
            requireValue(Number.isFinite(elapsedMs) && elapsedMs > 0, 'Invalid validation interval')
            if (native !== null) {
                requireValue(phase.calls === 1 && phase.fallbackCalls === 0, 'Native admission mismatch')
                requireValue(phase.copyInputBytes === group.inputCopyBytes, 'Native staging byte mismatch')
            }
            completedCalls++
        }
    }
    if (native !== null) {
        requireValue(native.metrics.calls === passes * checks.nativeCallsPerPass, 'Native total calls mismatch')
        requireValue(native.metrics.fallbackCalls === 0, 'Unexpected native fallback')
        requireValue(native.metrics.copyInputBytes === passes * checks.nativeCopiedInputBytesPerPass, 'Native total copy mismatch')
        requireValue(native.metrics.peakHeapBytes === checks.expectedNativePeakHeapBytes, 'Native heap reservation mismatch')
    }
    stage = 'complete'
    postMessage({type: 'complete', completedCalls, nativeInitializationElapsedMs, initialization,
        finalNativeMetrics: native?.metrics ?? null,
        runtime: {userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemoryGiB: navigator.deviceMemory, crossOriginIsolated, performanceTimeOrigin: performance.timeOrigin}})
}
self.onmessage = ({data}) => {
    if (data.type === 'ack') {
        const pending = acknowledgement
        acknowledgement = null
        if (pending === null) throw new Error('Unexpected acknowledgement')
        if (data.pass !== pending.pass || data.group !== pending.group) pending.reject(new Error('Out-of-order acknowledgement'))
        else pending.resolve()
        return
    }
    requireValue(data.type === 'start' && !started, 'Repeated or invalid worker start')
    started = true
    run(data).catch((error) => postMessage({type: 'failed', stage, currentCall, error: String(error?.stack || error)}))
}
