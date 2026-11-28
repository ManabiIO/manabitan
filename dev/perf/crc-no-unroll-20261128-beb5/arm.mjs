/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {appendFileSync, writeFileSync} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {Worker} from 'node:worker_threads'
import {sha256, loadIdentity} from './common.mjs'

const [inputDirectory, evidenceDirectory, armDirectory, variant, armId] = process.argv.slice(2)
assert.ok(inputDirectory && evidenceDirectory && armDirectory && armId)
assert.ok(['baseline', 'candidate'].includes(variant))
const journal = path.join(armDirectory, 'observations.jsonl')
writeFileSync(journal, '', {flag: 'wx'})
const save = entry => appendFileSync(journal, JSON.stringify(entry) + '\n')
const report = {passed: false, variant, armId, phases: [], groups: [],
    nodeVersion: process.version, v8Version: process.versions.v8, pid: process.pid,
    execArgv: process.execArgv, nodeOptions: process.env.NODE_OPTIONS ?? '',
    scope: 'One fresh default Node process, three fresh worker isolates, private instances sharing only compiled module code. Groups run serially round-robin. Timers cover the exact production inflater API, not full parsing or browser import.'}
const endpoints = []
let current = {stage: 'identity'}

function endpoint(worker, index) {
    const queued = new Map()
    const pending = new Map()
    let fatal
    let closing = false
    const fail = error => {
        fatal = error
        for (const {reject} of pending.values()) { reject(error) }
        pending.clear()
    }
    worker.on('message', message => {
        save({event: 'worker-message', workerIndex: index, message})
        if (message.type === 'fatal') {
            fail(new Error('Worker ' + index + ': ' + message.message))
            return
        }
        const waiter = pending.get(message.type)
        if (waiter) { pending.delete(message.type); waiter.resolve(message) }
        else {
            const entries = queued.get(message.type) ?? []
            entries.push(message)
            queued.set(message.type, entries)
        }
    })
    worker.on('error', fail)
    worker.on('exit', code => {
        if (!closing) { fail(new Error('Unexpected worker exit ' + index + ': ' + code)) }
    })
    return {
        worker,
        wait(type) {
            if (fatal) { return Promise.reject(fatal) }
            const entries = queued.get(type)
            if (entries?.length) { return Promise.resolve(entries.shift()) }
            assert.equal(pending.has(type), false)
            return new Promise((resolve, reject) => pending.set(type, {resolve, reject}))
        },
        async close() { closing = true; await worker.terminate() },
    }
}

try {
    assert.equal(process.version, 'v22.22.0')
    assert.deepEqual(process.execArgv, [])
    assert.equal((process.env.NODE_OPTIONS ?? '').trim(), '')
    assert.equal((process.env.NODE_COMPILE_CACHE ?? '').trim(), '')
    const identity = await loadIdentity(inputDirectory, evidenceDirectory)
    const {manifest, build} = identity
    Object.assign(report, {registrationSha256: identity.registrationSha256, buildSha256: identity.buildSha256,
        captureManifestSha256: identity.captureManifestSha256})
    const bytes = await readFile(path.join(evidenceDirectory, 'modules', variant + '.wasm'))
    report.moduleSha256 = sha256(bytes)
    assert.equal(report.moduleSha256, build.variants[variant].wasmSha256)
    const verifyBytes = await readFile(path.join(evidenceDirectory, 'verify.json'))
    const verification = JSON.parse(verifyBytes)
    assert.equal(verification.passed, true)
    assert.equal(verification.buildSha256, identity.buildSha256)
    assert.equal(verification.captureManifestSha256, identity.captureManifestSha256)
    report.correctnessReceiptSha256 = sha256(verifyBytes)
    current = {stage: 'initialization'}
    const initializedAt = performance.now()
    const module = await WebAssembly.compile(bytes)
    report.compilationMs = performance.now() - initializedAt
    assert.deepEqual(WebAssembly.Module.imports(module), [])
    for (let index = 0; index < 3; ++index) {
        endpoints.push(endpoint(new Worker(new URL('./arm-worker.mjs', import.meta.url), {
            workerData: {module, inputDirectory, workerIndex: index,
                groups: manifest.groups.filter(group => group.groupIndex % 3 === index)},
        }), index))
    }
    report.workers = await Promise.all(endpoints.map(entry => entry.wait('initialized')))
    report.initializationWallMs = performance.now() - initializedAt
    assert.equal(new Set(report.workers.map(worker => worker.threadId)).size, 3)
    for (const worker of report.workers) { assert.deepEqual(worker.execArgv, []) }
    current = {stage: 'input-preparation'}
    const preparedAt = performance.now()
    for (const entry of endpoints) { entry.worker.postMessage({type: 'prepare'}) }
    report.prepared = await Promise.all(endpoints.map(entry => entry.wait('prepared')))
    report.inputPreparationWallMs = performance.now() - preparedAt
    save({event: 'ready', initializationWallMs: report.initializationWallMs,
        compilationMs: report.compilationMs, inputPreparationWallMs: report.inputPreparationWallMs})

    for (const phase of ['first-pass', 'second-pass']) {
        const observations = []
        for (const group of manifest.groups) {
            current = {stage: 'group', phase, groupIndex: group.groupIndex}
            const selected = endpoints[group.groupIndex % 3]
            save({event: 'group-dispatch', phase, groupIndex: group.groupIndex, workerIndex: group.groupIndex % 3})
            selected.worker.postMessage({type: 'run-group', phase, groupIndex: group.groupIndex})
            const observation = await selected.wait('group-result')
            report.groups.push(observation)
            observations.push(observation)
            assert.equal(observation.groupIndex, group.groupIndex)
            assert.equal(observation.phase, phase)
            assert.equal(observation.workerIndex, group.groupIndex % 3)
            assert.equal(observation.invocation, (phase === 'first-pass' ? 0 : 4) + Math.floor(group.groupIndex / 3) + 1)
            assert.equal(observation.firstInvocation, phase === 'first-pass' && group.groupIndex < 3)
            assert.equal(observation.passed, true, JSON.stringify(observation.error))
            assert.ok(Number.isFinite(observation.owningMs) && observation.owningMs > 0)
            assert.ok(observation.nativeInflateAndCrcMs >= 0 && observation.nativeInflateAndCrcMs <= observation.owningMs + 0.001)
            assert.equal(observation.decodedSha256, group.decodedSha256)
            assert.equal(observation.memoryShared, true)
        }
        const sum = key => observations.reduce((total, entry) => total + entry[key], 0)
        const summary = {phase, groupCount: observations.length, owningMs: sum('owningMs'),
            nativeInflateAndCrcMs: sum('nativeInflateAndCrcMs'), compressedBytes: sum('compressedBytes'),
            decodedBytes: sum('decodedBytes'), rows: sum('rows'),
            firstInstanceInvocationMs: observations.filter(entry => entry.firstInvocation).reduce((total, entry) => total + entry.owningMs, 0),
            subsequentInvocationMs: observations.filter(entry => !entry.firstInvocation).reduce((total, entry) => total + entry.owningMs, 0),
            maximumInstanceCapacityBytes: Math.max(...observations.map(entry => entry.wasmCapacityBytes))}
        assert.equal(summary.groupCount, 12)
        assert.equal(summary.compressedBytes, manifest.compressedBytes)
        assert.equal(summary.decodedBytes, manifest.decodedBytes)
        assert.equal(summary.rows, manifest.totalRows)
        report.phases.push(summary)
        save({event: 'phase-complete', ...summary})
    }
    report.startupPlusFirstPassOwningMs = report.initializationWallMs + report.phases[0].owningMs
    report.passed = true
    console.log(JSON.stringify({passed: true, armId, variant, phases: report.phases,
        initializationWallMs: report.initializationWallMs, startupPlusFirstPassOwningMs: report.startupPlusFirstPassOwningMs}))
} catch (error) {
    report.failure = {current, name: error.name, message: error.message, stack: error.stack}
    save({event: 'failure', ...report.failure})
    throw error
} finally {
    await Promise.allSettled(endpoints.map(entry => entry.close()))
    writeFileSync(path.join(armDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
}
