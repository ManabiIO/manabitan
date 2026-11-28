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
import {childPath, hash, loadInputs, readJson, toolingRoot, verifySourceInventory, writeJson} from './common.mjs'

const {values} = parseArgs({options: {
    inputs: {type: 'string'}, output: {type: 'string'},
}})
assert(values.inputs && values.output)
const inputRoot = path.resolve(values.inputs)
const {protocol, inventory, protocolSha256, inputInventorySha256} = await loadInputs(inputRoot)
assert.equal(process.version, protocol.nodeVersion)

assert.equal(protocol.schedule.length, protocol.observations)
assert.equal(new Set(protocol.schedule.map(({id}) => id)).size, protocol.observations)
if (process.env.GITHUB_RUN_ATTEMPT !== undefined) { assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'Rerun acquisitions are not permitted') }
const sourceInventorySha256 = await verifySourceInventory()
const output = path.resolve(values.output)
await mkdir(output)
await mkdir(path.join(output, 'observations'))
await mkdir(path.join(output, 'logs'))
const assets = new Map()
for (const name of ['worker.mjs', 'baseline-loop.mjs', 'native-validator.mjs', 'record-run-validator.wasm']) {
    assets.set('/' + name, await readFile(path.join(toolingRoot, name)))
}
assert.equal(hash(assets.get('/record-run-validator.wasm')), protocol.kernel.sha256)
assert.equal(hash(assets.get('/native-validator.mjs')), protocol.adapter.sha256)
assert.equal(hash(assets.get('/baseline-loop.mjs')), protocol.javascript.sha256)
const acquisition = {
    schemaVersion: 1, protocolSha256, sourceInventorySha256, inputInventorySha256,
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
            bytes = Buffer.from('<!doctype html><meta charset="utf-8"><title>Record validation component</title>')
        } else if (assets.has(pathname)) {
            response.setHeader('Content-Type', pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript; charset=utf-8')
            bytes = assets.get(pathname)
        } else {
            const match = /^\/inputs\/(\d+)$/.exec(pathname)
            if (match === null) {
                response.statusCode = 404
                response.end()
                return
            }
            const group = inventory.groups.find((entry) => entry.group === Number(match[1]))
            assert(group)
            if (cachedGroup !== group.group) {
                cachedGroup = group.group
                cachedSnapshot = readFile(childPath(inputRoot, group.file)).then((payload) => {
                    assert.equal(payload.byteLength, group.bytes)
                    assert.equal(hash(payload), group.sha256)
                    return payload
                })
            }
            bytes = await cachedSnapshot
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
            '--id', observation.id, '--origin', origin, '--output', destination,
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
            report = {schemaVersion: 1, observation, status: 'failed', calls: [],
                protocolSha256, sourceInventorySha256, inputInventorySha256, error: String(error)}
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
        const finalInputs = await loadInputs(inputRoot)
        assert.equal(finalInputs.protocolSha256, protocolSha256)
        assert.equal(finalInputs.inputInventorySha256, inputInventorySha256)
        for (const [url, initial] of assets) {
            assert.equal(hash(await readFile(path.join(toolingRoot, url.slice(1)))), hash(initial))
        }
        acquisition.finalIdentityCheck = 'passed'
    } catch (error) {
        failed = true
        acquisition.finalIdentityCheck = 'failed'
        acquisition.identityError = String(error?.stack || error)
    }
    acquisition.finishedAt = new Date().toISOString()
    acquisition.complete = acquisition.observations.length === protocol.observations
    acquisition.allSucceeded = acquisition.complete && !failed
    await writeJson(path.join(output, 'acquisition.json'), acquisition)
}
if (failed) { process.exitCode = 1 }
