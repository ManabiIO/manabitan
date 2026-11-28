import assert from 'node:assert/strict'
import {readFileSync, writeFileSync, mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import os from 'node:os'
import {here, plan, verifyPlan, verifySources, contrast} from './common.mjs'

assert(process.argv.length === 3 || process.argv.length === 4)
const untimedOnly = process.argv[3] === '--untimed-only'
assert(process.argv.length === 3 || untimedOnly)
const outputDirectory = resolve(process.argv[2])
const prepared = JSON.parse(readFileSync(resolve(outputDirectory, 'preparation.json')))
assert.equal(prepared.complete, true)
if (!untimedOnly) {
    assert.equal(process.version, plan.nodeVersion)
    assert.equal(prepared.localUntimed, false)
    assert.equal(process.env.GITHUB_ACTIONS, 'true')
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1')
}
const screen = resolve(outputDirectory, untimedOnly ? 'untimed-verification' : 'screen')
mkdirSync(screen)
mkdirSync(resolve(screen, 'observations'))
const observations = []
const acquisition = {complete: false, untimedOnly, timingAcquisition: !untimedOnly, plannedNode: plan.nodeVersion, node: process.version, source: null, schedule: [], attempted: 0}
const save = () => {
    writeFileSync(resolve(screen, 'acquisition.json'), JSON.stringify(acquisition, null, 2) + '\n')
    writeFileSync(resolve(screen, 'observations.json'), JSON.stringify(observations, null, 2) + '\n')
}
try {
    verifyPlan()
    acquisition.source = verifySources()
    assert.deepEqual(acquisition.source, prepared.sources)
    acquisition.host = {platform: os.platform(), release: os.release(), architecture: os.arch(), cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))], logicalCpuCount: os.cpus().length, totalMemoryBytes: os.totalmem(), imageVersion: process.env.ImageVersion ?? null, imageOs: process.env.ImageOS ?? null, affinity: readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1] ?? null}
    acquisition.flags = {parentExecArgv: process.execArgv, childExecArgv: [], compileCacheDisabled: true, removedChildEnvironmentOptions: ['NODE_COMPILE_CACHE', 'NODE_OPTIONS', 'NODE_V8_COVERAGE']}
    if (untimedOnly) {
        acquisition.schedule = ['A', 'B', 'C'].map((arm, position) => ({phase: 'verification', block: null, cycle: 0, position, arm, mode: 'untimed'}))
    } else {
        const affinity = JSON.parse(readFileSync(resolve(outputDirectory, 'affinity.json')))
        acquisition.affinity = affinity
        assert.equal(acquisition.host.affinity, String(affinity.selectedCpu))
        acquisition.schedule = [
            ...plan.warmupCycles.flatMap((order, cycle) => [...order].map((arm, position) => ({phase: 'warmup', block: null, cycle, position, arm, mode: 'untimed'}))),
            ...plan.blocks.flatMap((order, block) => [...order].map((arm, position) => ({phase: 'measured', block, cycle: null, position, arm, mode: 'timed'}))),
        ]
        assert.equal(acquisition.schedule.length, 42)
    }
    save()
    const environment = {...process.env, NODE_DISABLE_COMPILE_CACHE: '1'}
    delete environment.NODE_COMPILE_CACHE
    delete environment.NODE_OPTIONS
    delete environment.NODE_V8_COVERAGE
    for (let index = 0; index < acquisition.schedule.length; ++index) {
        const entry = acquisition.schedule[index]
        const name = `${String(index).padStart(3, '0')}-${entry.phase}-${entry.arm}`
        const directory = resolve(screen, 'observations', name)
        const result = spawnSync(process.execPath, [resolve(here, 'observation.mjs'), entry.arm, entry.mode, directory], {encoding: 'utf8', env: environment, timeout: 120000, maxBuffer: 8 * 1024 * 1024})
        writeFileSync(resolve(screen, 'observations', name + '.stdout.txt'), result.stdout ?? '')
        writeFileSync(resolve(screen, 'observations', name + '.stderr.txt'), result.stderr ?? '')
        let receipt
        try { receipt = JSON.parse(readFileSync(resolve(directory, 'receipt.json'))) } catch (error) { receipt = {complete: false, error: String(error)} }
        const observation = {...entry, index, name, exitCode: result.status, signal: result.signal, spawnError: result.error ? String(result.error) : null, ...receipt}
        observations.push(observation)
        ++acquisition.attempted
        save()
        assert.equal(result.status, 0, JSON.stringify(observation))
        assert.equal(receipt.complete, true)
        assert.equal(receipt.arm, entry.arm)
        assert.equal(receipt.mode, entry.mode)
        assert.deepEqual(receipt.source, acquisition.source)
        assert.equal(receipt.outputDigest, plan.expectedOutputDigest)
        assert.equal(receipt.affinity, acquisition.host.affinity)
        if (entry.mode === 'timed') assert(receipt.timing.cpuMs > 0 && receipt.timing.wallMs > 0)
        else assert.equal(receipt.timing, null)
        console.log(JSON.stringify({index, phase: entry.phase, block: entry.block, arm: entry.arm, timing: receipt.timing, complete: true}))
    }
    if (untimedOnly) {
        writeFileSync(resolve(screen, 'summary.json'), JSON.stringify({complete: true, untimedOnly: true, observations: observations.length, rowsPerObservation: 528299, expectedOutputDigest: plan.expectedOutputDigest, noTimingAcquired: true}, null, 2) + '\n')
    } else {
        assert.equal(observations.filter((item) => item.phase === 'measured').length, 36)
        assert.equal(observations.filter((item) => item.phase === 'warmup').length, 6)
        const contrasts = {}
        for (const metric of ['cpuMs', 'wallMs']) {
            contrasts[metric] = {BoverA: contrast(observations, 'B', 'A', metric), BoverC: contrast(observations, 'B', 'C', metric), CoverA: contrast(observations, 'C', 'A', metric)}
        }
        const primary = contrasts.cpuMs
        const gate = plan.nominationGate
        const checks = {
            BoverAMedianReduction: primary.BoverA.medianPercent <= -gate.minimumMedianPairedCpuReductionPercent,
            BoverCMedianReduction: primary.BoverC.medianPercent <= -gate.minimumMedianPairedCpuReductionPercent,
            BoverAMedianSaving: primary.BoverA.medianSaving >= gate.minimumMedianPairedCpuSavingMs,
            BoverCMedianSaving: primary.BoverC.medianSaving >= gate.minimumMedianPairedCpuSavingMs,
            BoverAFasterPairs: primary.BoverA.fasterPairs >= gate.minimumFasterPairsAgainstEachControl,
            BoverCFasterPairs: primary.BoverC.fasterPairs >= gate.minimumFasterPairsAgainstEachControl,
            controlMedianStable: Math.abs(primary.CoverA.medianPercent) <= gate.maximumAbsoluteControlMedianPercent,
            controlEqualWorkStable: Math.abs(primary.CoverA.equalWorkPercent) <= gate.maximumAbsoluteControlEqualWorkPercent,
            allSourceOutputAndWorkIdentitiesPassed: observations.every((item) => item.complete),
        }
        const summary = {complete: true, componentOnly: true, independentWholeBrowserQualificationRequired: true, measuredObservations: 36, warmupObservations: 6, contrasts, gate, checks, nominationGatePassed: Object.values(checks).every(Boolean), noObservationsRemoved: true}
        writeFileSync(resolve(screen, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
        console.log(JSON.stringify({complete: true, nominationGatePassed: summary.nominationGatePassed, primaryCpu: primary, componentOnly: true}))
    }
    acquisition.complete = true
} catch (error) {
    acquisition.error = String(error)
    acquisition.stack = error.stack
    process.exitCode = 1
} finally { save() }
