/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {createWriteStream, appendFileSync, writeFileSync} from 'node:fs'
import {mkdir, readFile} from 'node:fs/promises'
import path from 'node:path'
import {here, sha256, loadIdentity} from './common.mjs'

const [inputDirectory, evidenceDirectory] = process.argv.slice(2)
assert.ok(inputDirectory && evidenceDirectory)
const directory = path.join(evidenceDirectory, 'campaign')
await mkdir(directory, {recursive: false})
const identity = await loadIdentity(inputDirectory, evidenceDirectory)
const verifyBytes = await readFile(path.join(evidenceDirectory, 'verify.json'))
const verification = JSON.parse(verifyBytes)
assert.equal(verification.passed, true)
assert.equal(verification.buildSha256, identity.buildSha256)
assert.equal(verification.captureManifestSha256, identity.captureManifestSha256)
assert.equal(verification.vectors.length, 837)
assert.equal(verification.conformance.length, 157)
assert.equal(verification.groups.length, 12)
const schedule = []
for (let pair = 0; pair < 6; ++pair) {
    const scenarios = pair % 2 === 0 ? ['treatment', 'control'] : ['control', 'treatment']
    for (const scenario of scenarios) {
        const arms = scenario === 'treatment' ? ['A', 'B'] : ['A', 'C']
        if (pair % 2 !== 0) { arms.reverse() }
        for (const label of arms) {
            schedule.push({pair, scenario, label, variant: label === 'B' ? 'candidate' : 'baseline',
                armId: scenario + '-' + String(pair + 1).padStart(2, '0') + '-' + label})
        }
    }
}
assert.equal(schedule.length, 24)
const plan = {registrationSha256: identity.registrationSha256, buildSha256: identity.buildSha256,
    captureManifestSha256: identity.captureManifestSha256, correctnessReceiptSha256: sha256(verifyBytes),
    schedule, armTimeoutMs: 180000, timingProcesses: 'Fresh default Node 22.22.0 process per arm; no VM flags, no forced GC or tier control.'}
writeFileSync(path.join(directory, 'registered-plan.json'), JSON.stringify(plan, null, 2) + '\n', {flag: 'wx'})
const journal = path.join(directory, 'arms.jsonl')
writeFileSync(journal, '', {flag: 'wx'})
const observations = []

async function runArm(entry) {
    const armDirectory = path.join(directory, entry.armId)
    await mkdir(armDirectory, {recursive: false})
    writeFileSync(path.join(armDirectory, 'identity.json'), JSON.stringify(entry, null, 2) + '\n', {flag: 'wx'})
    const stdout = createWriteStream(path.join(armDirectory, 'stdout.log'), {flags: 'wx'})
    const stderr = createWriteStream(path.join(armDirectory, 'stderr.log'), {flags: 'wx'})
    const args = [path.join(here, 'arm.mjs'), inputDirectory, evidenceDirectory, armDirectory, entry.variant, entry.armId]
    let timedOut = false
    let exit = {code: null, signal: null}
    let spawnError = null
    let timer
    try {
        const child = spawn(process.execPath, args, {stdio: ['ignore', 'pipe', 'pipe'], env: process.env})
        child.stdout.pipe(stdout)
        child.stderr.pipe(stderr)
        timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, plan.armTimeoutMs)
        exit = await new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('close', (code, signal) => resolve({code, signal}))
        })
    } catch (error) {
        spawnError = {name: error.name, message: error.message, stack: error.stack}
    } finally {
        clearTimeout(timer)
        await Promise.all([new Promise(resolve => stdout.end(resolve)), new Promise(resolve => stderr.end(resolve))])
    }
    let report = null
    try { report = JSON.parse(await readFile(path.join(armDirectory, 'report.json'), 'utf8')) } catch {}
    const observation = {...entry, exit, timedOut, spawnError, report}
    appendFileSync(journal, JSON.stringify(observation) + '\n')
    observations.push(observation)
    assert.equal(spawnError, null, 'Spawn failure is retained without replacement: ' + entry.armId)
    assert.equal(timedOut, false, 'Timed-out arm is retained without replacement: ' + entry.armId)
    assert.equal(exit.code, 0, 'Failed arm is retained without replacement: ' + entry.armId)
    assert.equal(exit.signal, null)
    assert.equal(report?.passed, true)
    assert.equal(report.moduleSha256, identity.build.variants[entry.variant].wasmSha256)
    assert.equal(report.correctnessReceiptSha256, sha256(verifyBytes))
    assert.equal(report.groups.length, 24)
    console.log(JSON.stringify({armId: entry.armId, passed: true, firstPassMs: report.phases[0].owningMs,
        secondPassMs: report.phases[1].owningMs, initializationWallMs: report.initializationWallMs}))
}

const median = values => {
    const sorted = [...values].sort((a, b) => a - b)
    return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
}
function assess() {
    const cells = []
    for (const scenario of ['treatment', 'control']) {
        const label = scenario === 'treatment' ? 'B' : 'C'
        for (const phase of ['first-pass', 'second-pass', 'startup-plus-first-pass']) {
            const pairs = []
            for (let pair = 0; pair < 6; ++pair) {
                const select = armLabel => observations.find(entry => entry.scenario === scenario && entry.pair === pair && entry.label === armLabel)
                const first = select('A')
                const second = select(label)
                assert.ok(first && second)
                const value = entry => phase === 'startup-plus-first-pass' ? entry.report.startupPlusFirstPassOwningMs :
                    entry.report.phases.find(item => item.phase === phase).owningMs
                const baselineMs = value(first)
                const comparedMs = value(second)
                pairs.push({pair, baselineArmId: first.armId, comparedArmId: second.armId,
                    baselineMs, comparedMs, ratio: comparedMs / baselineMs, deltaMs: comparedMs - baselineMs})
            }
            cells.push({scenario, phase, pairs,
                medianRatio: median(pairs.map(pair => pair.ratio)),
                equalWorkRatio: pairs.reduce((sum, pair) => sum + pair.comparedMs, 0) / pairs.reduce((sum, pair) => sum + pair.baselineMs, 0),
                fasterPairs: pairs.filter(pair => pair.ratio < 1).length})
        }
    }
    return cells
}
try {
    for (const entry of schedule) { await runArm(entry) }
    assert.equal(observations.length, 24)
    const analysis = {passed: true, registrationSha256: identity.registrationSha256,
        buildSha256: identity.buildSha256, captureManifestSha256: identity.captureManifestSha256,
        observations: observations.length, measuredGroups: observations.reduce((sum, entry) => sum + entry.report.groups.length, 0),
        scope: 'Owning inflate+CRC+allocation+input-copy work only. First and second complete passes are separate. Startup wall plus summed serial work is a component diagnostic, not parallel import elapsed time.',
        cells: assess()}
    assert.equal(analysis.measuredGroups, 576)
    writeFileSync(path.join(directory, 'analysis.json'), JSON.stringify(analysis, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify({passed: true, observations: analysis.observations,
        measuredGroups: analysis.measuredGroups, cells: analysis.cells.map(({pairs, ...rest}) => rest)}))
} catch (error) {
    writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({completedArms: observations.length,
        name: error.name, message: error.message, stack: error.stack,
        noReplacementOrRetry: true}, null, 2) + '\n', {flag: 'wx'})
    throw error
}
