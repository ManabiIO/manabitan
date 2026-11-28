/* Copyright (C) 2026 Manabitan authors. SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createRequire} from 'node:module'
import {access, readFile} from 'node:fs/promises'
import path from 'node:path'
import {parseArgs} from 'node:util'
import {chromium} from 'playwright'
import {hash, hashFile, toolingRoot, verifySourceInventory, writeJson} from './common.mjs'

const {values} = parseArgs({options: {
    id: {type: 'string'}, origin: {type: 'string'}, output: {type: 'string'},
}})
assert(values.id && values.origin && values.output)
const protocolBytes = await readFile(path.join(toolingRoot, 'protocol.json'))
const protocol = JSON.parse(protocolBytes)
assert.equal(process.version, protocol.nodeVersion)
assert.equal(createRequire(import.meta.url)('playwright/package.json').version, protocol.browser.playwrightVersion)
assert.equal(protocol.status, 'frozen', 'Protocol is not frozen')
const observation = protocol.schedule.find(({id}) => id === values.id)
assert(observation)
const origin = new URL(values.origin)
assert.equal(origin.hostname, '127.0.0.1')
assert.equal(origin.protocol, 'http:')
const moduleBinding = observation.arm === 'A' ? protocol.javascript : protocol.kernel
const sourceInventorySha256 = await verifySourceInventory()
const inventoryBytes = await readFile(path.join(toolingRoot, protocol.inputInventoryFile))
assert.equal(hash(inventoryBytes), protocol.inputInventorySha256)
const inventory = JSON.parse(inventoryBytes)
const output = path.resolve(values.output)
await assert.rejects(access(output), {code: 'ENOENT'})
const report = {
    schemaVersion: 1, observation, status: 'running',
    protocolSha256: hash(protocolBytes), sourceInventorySha256,
    inputInventorySha256: hash(inventoryBytes),
    module: {id: moduleBinding.id, sha256: moduleBinding.sha256},
    nodeVersion: process.version, nodeExecArgv: process.execArgv,
    startedAt: new Date().toISOString(), stage: 'browser-identity', calls: [],
}
await writeJson(output, report)
let server = null
let accepting = true
let pendingWrite = Promise.resolve()
let timeout = null
let failure = null
const deadline = new Promise((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Prespecified observation deadline exceeded')), protocol.observationTimeoutMs)
})
async function acquire() {
    const executablePath = chromium.executablePath()
    const executableVersion = execFileSync(executablePath, ['--version'], {encoding: 'utf8'}).trim()
    assert.equal(executableVersion, protocol.browser.executableVersion)
    const executableSha256 = await hashFile(executablePath)
    assert.equal(executableSha256, protocol.browser.executableSha256)
    assert(accepting, 'Observation deadline already reached')
    report.browser = {executablePath, executableVersion, executableSha256}
    report.stage = 'launch'
    await writeJson(output, report)
    server = await chromium.launchServer({executablePath, headless: true, timeout: 30000, host: '127.0.0.1'})
    if (!accepting) {
        await server.kill()
        throw new Error('Observation deadline reached during launch')
    }
    const browserProcess = server.process()
    report.browser.processId = browserProcess.pid
    report.browser.arguments = browserProcess.spawnargs
    await writeJson(output, report)
    assert(!browserProcess.spawnargs.some((argument) => /^--(?:js-flags|enable-features=.*[Ww]asm|disable-features=.*[Ww]asm)/.test(argument)))
    const browser = await chromium.connect(server.wsEndpoint(), {timeout: 30000})
    assert(accepting, 'Observation deadline already reached')
    report.browser.version = browser.version()
    assert.equal(report.browser.version, protocol.browser.version)
    report.stage = 'page'
    await writeJson(output, report)
    const context = await browser.newContext()
    const page = await context.newPage()
    await page.exposeFunction('recordValidationCall', async (call) => {
        assert(accepting, 'Observation already closed')
        const index = report.calls.length
        assert.equal(call.pass, Math.floor(index / protocol.callsPerPass) + 1)
        assert.equal(call.group, index % protocol.callsPerPass + 1)
        report.calls.push(call)
        report.stage = 'calls'
        pendingWrite = pendingWrite.then(() => writeJson(output, report))
        await pendingWrite
    })
    await page.goto(origin.href, {waitUntil: 'load'})
    const completion = await page.evaluate(async (input) => await new Promise((resolve, reject) => {
        const worker = new Worker('/worker.mjs', {type: 'module'})
        const failed = (error) => {
            worker.terminate()
            reject(error)
        }
        worker.onerror = (event) => failed(new Error(event.message))
        worker.onmessageerror = () => failed(new Error('Worker message could not be decoded'))
        worker.onmessage = async ({data}) => {
            try {
                if (data.type === 'call') {
                    await globalThis.recordValidationCall(data.call)
                    worker.postMessage({type: 'ack', pass: data.call.pass, group: data.call.group})
                } else if (data.type === 'complete') {
                    worker.terminate()
                    resolve(data)
                } else {
                    failed(new Error(JSON.stringify(data)))
                }
            } catch (error) {
                failed(error)
            }
        }
        worker.postMessage(input)
    }), {type: 'start', arm: observation.arm, kernel: protocol.kernel, groups: inventory.groups, passes: protocol.passes, worker: protocol.worker, checks: protocol.checks})
    assert.equal(completion.completedCalls, protocol.callsPerObservation)
    assert.equal(report.calls.length, protocol.callsPerObservation)
    assert.equal(completion.runtime.crossOriginIsolated, protocol.worker.crossOriginIsolated)
    report.worker = completion.runtime
    report.nativeInitializationElapsedMs = completion.nativeInitializationElapsedMs
    report.initialization = completion.initialization
    report.finalNativeMetrics = completion.finalNativeMetrics
}
try {
    await Promise.race([acquire(), deadline])
} catch (error) {
    failure = String(error?.stack || error)
} finally {
    clearTimeout(timeout)
    accepting = false
    if (server !== null) {
        try {
            await server.kill()
        } catch (error) {
            failure = [failure, `Browser cleanup failed: ${error?.stack || error}`].filter(Boolean).join('\n')
        }
    }
    await pendingWrite.catch((error) => { failure = [failure, String(error?.stack || error)].filter(Boolean).join('\n') })
    report.finishedAt = new Date().toISOString()
    report.status = failure === null ? 'success' : 'failed'
    report.stage = 'finished'
    if (failure !== null) { report.error = failure }
    await writeJson(output, report)
}
console.log(JSON.stringify({id: observation.id, status: report.status, calls: report.calls.length}))
if (report.status !== 'success') { process.exitCode = 1 }
