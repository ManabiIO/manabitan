/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createWriteStream} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import {createServer} from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {parseArgs} from 'node:util'
import {hash, loadInputs, loadSnapshot, readJson, toolingRoot, verifySourceInventory, writeJson} from './common.mjs'

const {values} = parseArgs({options: {
    variant: {type: 'string'}, snapshots: {type: 'string'}, modules: {type: 'string'}, output: {type: 'string'},
}})
assert(values.variant && values.snapshots && values.modules && values.output)
const snapshotRoot = path.resolve(values.snapshots)
const {protocol, inventory, protocolSha256, snapshotInventorySha256} = await loadInputs(snapshotRoot)
assert.equal(process.version, protocol.nodeVersion)
assert(protocol.variants[values.variant])
assert.equal(protocol.schedule.length, protocol.observationsPerVariant)
assert.equal(new Set(protocol.schedule.map(({id}) => id)).size, protocol.observationsPerVariant)
if (process.env.GITHUB_RUN_ATTEMPT !== undefined) { assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Rerun acquisitions are not permitted') }
const sourceInventorySha256 = await verifySourceInventory()
const output = path.resolve(values.output)
await mkdir(output)
await mkdir(path.join(output, 'observations'))
await mkdir(path.join(output, 'logs'))
const modules = new Map()
for (const binding of [protocol.baseline, ...Object.values(protocol.variants)]) {
    const bytes = await readFile(path.join(values.modules, binding.id + '.wasm'))
    assert.equal(hash(bytes), binding.sha256)
    assert(WebAssembly.validate(bytes))
    modules.set('/modules/' + binding.id + '.wasm', bytes)
}
const worker = await readFile(path.join(toolingRoot, 'worker.mjs'))
const acquisition = {
    schemaVersion: 1, variant: values.variant, protocolSha256, sourceInventorySha256, snapshotInventorySha256,
    startedAt: new Date().toISOString(), complete: false, observations: [],
    host: {platform: process.platform, architecture: process.arch, nodeVersion: process.version,
        cpus: os.cpus(), totalMemory: os.totalmem(), release: os.release()},
}
await writeJson(path.join(output, 'acquisition.json'), acquisition)
let cachedGroup = -1
let cachedSnapshot = null
const server = createServer((request, response) => {
    async function serve() {
        assert.equal(request.method, 'GET')
        response.setHeader('Cache-Control', 'no-store')
        response.setHeader('Cross-Origin-Opener-Policy', 'same-origin')
        response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp')
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
        const pathname = new URL(request.url, 'http://127.0.0.1').pathname
        let bytes
        if (pathname === '/') {
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            bytes = Buffer.from('<!doctype html><meta charset="utf-8"><title>Canonical component</title>')
        } else if (pathname === '/worker.mjs') {
            response.setHeader('Content-Type', 'text/javascript; charset=utf-8')
            bytes = worker
        } else if (modules.has(pathname)) {
            response.setHeader('Content-Type', 'application/wasm')
            bytes = modules.get(pathname)
        } else {
            const match = /^\/snapshots\/(\d+)\/(before|after)$/.exec(pathname)
            if (match === null) {
                response.statusCode = 404
                response.end()
                return
            }
            const group = inventory.groups.find((entry) => entry.group === Number(match[1]))
            assert(group)
            if (cachedGroup !== group.group) {
                cachedGroup = group.group
                cachedSnapshot = loadSnapshot(snapshotRoot, group)
            }
            bytes = (await cachedSnapshot)[match[2]]
            response.setHeader('Content-Type', 'application/octet-stream')
        }
        response.setHeader('Content-Length', bytes.byteLength)
        response.end(bytes)
    }
    serve().catch((error) => {
        console.error(String(error?.stack || error))
        if (!response.headersSent) { response.statusCode = 500 }
        response.end()
    })
})
await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
})
const origin = `http://127.0.0.1:${server.address().port}`
let failed = false
try {
    for (const observation of protocol.schedule) {
        const destination = path.join(output, 'observations', observation.id + '.json')
        const log = createWriteStream(path.join(output, 'logs', observation.id + '.log'), {flags: 'wx'})
        const child = spawn(process.execPath, [path.join(toolingRoot, 'observe.mjs'),
            '--variant', values.variant, '--id', observation.id, '--origin', origin, '--output', destination,
        ], {stdio: ['ignore', 'pipe', 'pipe']})
        child.stdout.pipe(log, {end: false})
        child.stderr.pipe(log, {end: false})
        const outcome = await new Promise((resolve) => {
            let timedOut = false
            const timeout = setTimeout(() => {
                timedOut = true
                child.kill('SIGKILL')
            }, protocol.observationTimeoutMs + 15000)
            child.once('error', (error) => {
                clearTimeout(timeout)
                resolve({code: null, signal: null, timedOut, error: String(error)})
            })
            child.once('close', (code, signal) => {
                clearTimeout(timeout)
                resolve({code, signal, timedOut})
            })
        })
        await new Promise((resolve) => log.end(resolve))
        let report
        try {
            report = await readJson(destination)
        } catch (error) {
            report = {schemaVersion: 1, variant: values.variant, observation, status: 'failed', calls: [],
                protocolSha256, sourceInventorySha256, snapshotInventorySha256, error: String(error)}
        }
        if (outcome.code !== 0 || report.status !== 'success') {
            failed = true
            report.status = 'failed'
            report.processOutcome = outcome
            if (outcome.timedOut && Number.isInteger(report.browser?.processId)) {
                // Playwright starts its browser as a separate process-group leader on Linux.
                // Kill only the group recorded by this observation if the child cleanup itself stalled.
                try {
                    process.kill(-report.browser.processId, 'SIGKILL')
                    report.browserCleanup = 'Killed timed-out observation browser process group'
                } catch (error) {
                    report.browserCleanup = String(error)
                }
            }
            await writeJson(destination, report)
        }
        acquisition.observations.push({id: observation.id, status: report.status, calls: report.calls.length, processOutcome: outcome})
        await writeJson(path.join(output, 'acquisition.json'), acquisition)
        console.log(JSON.stringify(acquisition.observations.at(-1)))
        if (observation !== protocol.schedule.at(-1)) { await delay(protocol.fixedInterObservationDelayMs) }
    }
} finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
    try {
        assert.equal(await verifySourceInventory(), sourceInventorySha256)
        const finalInputs = await loadInputs(snapshotRoot)
        assert.equal(finalInputs.protocolSha256, protocolSha256)
        assert.equal(finalInputs.snapshotInventorySha256, snapshotInventorySha256)
        for (const binding of [protocol.baseline, ...Object.values(protocol.variants)]) {
            assert.equal(hash(await readFile(path.join(values.modules, binding.id + '.wasm'))), binding.sha256)
        }
        acquisition.finalIdentityCheck = 'passed'
    } catch (error) {
        failed = true
        acquisition.finalIdentityCheck = 'failed'
        acquisition.identityError = String(error?.stack || error)
    }
    acquisition.finishedAt = new Date().toISOString()
    acquisition.complete = acquisition.observations.length === protocol.observationsPerVariant
    acquisition.allSucceeded = acquisition.complete && !failed
    await writeJson(path.join(output, 'acquisition.json'), acquisition)
}
if (failed) { process.exitCode = 1 }
