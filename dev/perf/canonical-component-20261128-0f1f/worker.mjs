/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
// Native call intervals only. Restoration, transport, comparison and hashing are outside each interval.
const requireValue = (condition, message) => {
    if (!condition) { throw new Error(message) }
}
const sha256 = async (bytes) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((value) => value.toString(16).padStart(2, '0')).join('')
async function fetchBytes(url) {
    const response = await fetch(url, {cache: 'no-store'})
    requireValue(response.ok, `Fetch failed: ${url} ${response.status}`)
    return response.arrayBuffer()
}
function allBytesEqual(actual, expected) {
    if (actual.byteLength !== expected.byteLength) { return false }
    const left = new Uint32Array(actual)
    const right = new Uint32Array(expected)
    for (let i = 0; i < left.length; ++i) {
        if (left[i] !== right[i]) { return false }
    }
    return true
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
async function run({module: binding, groups, passes, worker: workerPolicy}) {
    stage = 'module'
    requireValue(passes === 2 && groups.length === 12, 'Unexpected acquisition shape')
    requireValue(workerPolicy.crossOriginIsolated === true && crossOriginIsolated === true, 'Isolated worker timer policy mismatch')
    const moduleBytes = await fetchBytes(`/modules/${binding.id}.wasm`)
    requireValue(await sha256(moduleBytes) === binding.sha256, 'Module digest mismatch')
    const module = await WebAssembly.compile(moduleBytes)
    const pages = groups[0].memoryPages
    const memory = new WebAssembly.Memory({initial: pages, maximum: pages})
    const instance = new WebAssembly.Instance(module, {env: {memory}})
    requireValue(instance.exports.canonical_abi_version() === 1, 'ABI mismatch')
    requireValue(instance.exports.canonical_layout_end() === 8263840, 'Layout mismatch')
    requireValue(instance.exports.canonical_max_rows() === 100000, 'Row limit mismatch')
    requireValue(instance.exports.canonical_prefix_bytes() === 8388608, 'Prefix mismatch')
    const scan = instance.exports.scan_canonical
    requireValue(typeof scan === 'function', 'Missing scan export')
    let completedCalls = 0
    for (let pass = 1; pass <= passes; ++pass) {
        for (const group of groups) {
            currentCall = {pass, group: group.group}
            stage = 'input'
            const [before, after] = await Promise.all([
                fetchBytes(`/snapshots/${group.group}/before`),
                fetchBytes(`/snapshots/${group.group}/after`),
            ])
            requireValue(before.byteLength === pages * 65536 && after.byteLength === before.byteLength, 'Arena length mismatch')
            requireValue(group.memoryPages === pages && memory.buffer.byteLength === before.byteLength, 'Memory pages changed')
            requireValue(await sha256(before) === group.before.sha256, 'Input arena digest mismatch')
            requireValue(await sha256(after) === group.afterSha256, 'Expected arena digest mismatch')
            new Uint8Array(memory.buffer).set(new Uint8Array(before))
            stage = 'native'
            let returnValue = null
            let nativeError = null
            const start = performance.now()
            try {
                returnValue = scan()
            } catch (error) {
                nativeError = String(error?.stack || error)
            }
            const elapsedMs = performance.now() - start
            stage = 'output'
            const fullMemoryEqual = allBytesEqual(memory.buffer, after)
            const actualAfterSha256 = await sha256(memory.buffer)
            const call = {
                pass, group: group.group, rowCount: group.rowCount, uniqueRows: group.uniqueRows,
                elapsedMs, returnValue, expectedReturn: group.expectedReturn, fullMemoryEqual,
                actualAfterSha256, expectedAfterSha256: group.afterSha256,
            }
            if (nativeError !== null) { call.nativeError = nativeError }
            await publishCall(call)
            requireValue(nativeError === null, nativeError)
            requireValue(returnValue === group.expectedReturn, 'Native return mismatch')
            requireValue(fullMemoryEqual && actualAfterSha256 === group.afterSha256, 'Complete arena mismatch')
            requireValue(Number.isFinite(elapsedMs) && elapsedMs > 0, 'Invalid native interval')
            ++completedCalls
        }
    }
    stage = 'complete'
    postMessage({type: 'complete', completedCalls, runtime: {
        userAgent: navigator.userAgent, hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemoryGiB: navigator.deviceMemory, crossOriginIsolated,
        memoryPages: pages, performanceTimeOrigin: performance.timeOrigin,
    }})
}
self.onmessage = ({data}) => {
    if (data.type === 'ack') {
        const pending = acknowledgement
        acknowledgement = null
        if (pending === null) { throw new Error('Unexpected acknowledgement') }
        if (data.pass !== pending.pass || data.group !== pending.group) {
            pending.reject(new Error('Out-of-order acknowledgement'))
        } else {
            pending.resolve()
        }
        return
    }
    requireValue(data.type === 'start' && !started, 'Repeated or invalid worker start')
    started = true
    run(data).catch((error) => postMessage({type: 'failed', stage, currentCall, error: String(error?.stack || error)}))
}
