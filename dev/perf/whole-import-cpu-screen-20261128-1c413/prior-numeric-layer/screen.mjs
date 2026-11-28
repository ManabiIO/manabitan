// Source-only thin orchestration draft. It acquires nothing until root seals it.
// The common driver owns the single process-wide CPU interval; this file has no clocks.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {closeSync, openSync} from 'node:fs'
import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises'
import {availableParallelism} from 'node:os'
import {isAbsolute, relative, resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'

const selectedGate = {
    minimumMedianPairedCpuSavingMs: 20,
    minimumMedianPairedCpuReductionPercent: 1,
    minimumFasterPairsAgainstEachControl: 10,
    pairsPerControlPerReplication: 12,
    maximumAbsoluteControlPairedMedianPercent: 3,
    maximumAbsoluteControlSummedCpuRatioPercent: 3,
    absoluteControlMillisecondGate: null,
    bothIndependentReplicationsMustPassSeparately: true,
    allSourceOutputWorkActivationLifecycleChecksMandatory: true,
    wholeBrowserQualificationStillRequired: true,
}

export function schedule(replication) {
    assert.equal(replication.warmups.length, 2)
    assert.equal(replication.blocks.length, 12)
    for (const order of [...replication.warmups, ...replication.blocks]) {
        assert.equal([...order].sort().join(''), 'ABC')
    }
    const counts = Object.fromEntries(['ABC', 'ACB', 'BAC', 'BCA', 'CAB', 'CBA'].map((order) => [order, 0]))
    for (const order of replication.blocks) ++counts[order]
    assert(Object.values(counts).every((count) => count === 2))
    return [
        ...replication.warmups.flatMap((order, cycle) => [...order].map((arm, position) => ({phase: 'warmup', cycle, block: null, position, arm, mode: 'untimed'}))),
        ...replication.blocks.flatMap((order, block) => [...order].map((arm, position) => ({phase: 'measured', cycle: null, block, position, arm, mode: 'cpu-screen'}))),
    ].map((entry, index) => ({...entry, index}))
}

function median(values) {
    assert(values.length > 0)
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function clockValues(timing) {
    for (const snapshot of [timing.cpuBefore, timing.cpuAfter]) {
        for (const key of ['user', 'system']) assert(Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0)
    }
    const user = timing.cpuAfter.user - timing.cpuBefore.user
    const system = timing.cpuAfter.system - timing.cpuBefore.system
    assert(user >= 0 && system >= 0 && Number.isSafeInteger(user + system))
    for (const value of [timing.wallBeforeNs, timing.wallAfterNs]) assert(typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value))
    const duration = BigInt(timing.wallAfterNs) - BigInt(timing.wallBeforeNs)
    assert(duration > 0n && duration <= BigInt(Number.MAX_SAFE_INTEGER))
    const result = {cpuMicros: user + system, cpuMs: (user + system) / 1000,
        wallNs: Number(duration), wallMs: Number(duration) / 1e6}
    assert(result.cpuMs > 0)
    assert.equal(timing.cpuMs, result.cpuMs)
    assert.equal(timing.wallMs, result.wallMs)
    return result
}

export function contrast(observations, candidate, control, metric) {
    assert(metric === 'cpuMs' || metric === 'wallMs')
    const unitKey = metric === 'cpuMs' ? 'cpuMicros' : 'wallNs'
    const unitsPerMillisecond = metric === 'cpuMs' ? 1000 : 1e6
    const pairs = []
    for (let block = 0; block < 12; ++block) {
        const select = (arm) => observations.filter((item) => item.phase === 'measured' && item.block === block && item.arm === arm)
        const candidates = select(candidate)
        const controls = select(control)
        assert.equal(candidates.length, 1)
        assert.equal(controls.length, 1)
        const left = candidates[0].derivedTiming[unitKey]
        const right = controls[0].derivedTiming[unitKey]
        assert(Number.isSafeInteger(left) && left > 0 && Number.isSafeInteger(right) && right > 0)
        pairs.push({block, candidate: left / unitsPerMillisecond, control: right / unitsPerMillisecond,
            candidateUnits: left, controlUnits: right,
            percent: 100 * (left - right) / right, saving: (right - left) / unitsPerMillisecond})
    }
    const fractions = pairs.map((pair) => ({numerator: 100n * (BigInt(pair.candidateUnits) - BigInt(pair.controlUnits)),
        denominator: BigInt(pair.controlUnits)}))
    fractions.sort((a, b) => {
        const delta = a.numerator * b.denominator - b.numerator * a.denominator
        return delta < 0n ? -1 : delta > 0n ? 1 : 0
    })
    const middle = fractions.length / 2
    const left = fractions[middle - 1]
    const right = fractions[middle]
    const medianFraction = {numerator: left.numerator * right.denominator + right.numerator * left.denominator,
        denominator: 2n * left.denominator * right.denominator}
    const sum = (name) => pairs.reduce((total, pair) => total + BigInt(pair[name]), 0n)
    const summedFraction = {numerator: 100n * (sum('candidateUnits') - sum('controlUnits')),
        denominator: sum('controlUnits')}
    const display = (fraction) => Number(fraction.numerator) / Number(fraction.denominator)
    const serializable = (fraction) => ({numerator: fraction.numerator.toString(), denominator: fraction.denominator.toString()})
    const medianSavingUnits = median(pairs.map((pair) => pair.controlUnits - pair.candidateUnits))
    return {candidate, control, metric, unitKey, pairs,
        medianPercent: display(medianFraction), medianPercentFraction: serializable(medianFraction),
        medianSaving: medianSavingUnits / unitsPerMillisecond, medianSavingUnits,
        summedRatioPercent: display(summedFraction), summedRatioFraction: serializable(summedFraction),
        fasterPairs: pairs.filter((pair) => pair.candidateUnits < pair.controlUnits).length}
}

function percentageAtMost(fraction, limit) {
    assert(Number.isSafeInteger(limit))
    return BigInt(fraction.numerator) <= BigInt(limit) * BigInt(fraction.denominator)
}

function absolutePercentageAtMost(fraction, limit) {
    assert(Number.isSafeInteger(limit) && limit >= 0)
    const numerator = BigInt(fraction.numerator)
    return (numerator < 0n ? -numerator : numerator) <= BigInt(limit) * BigInt(fraction.denominator)
}

export function summarizeReplication(observations, gate) {
    assert.deepEqual(gate, selectedGate)
    assert.equal(observations.length, 42)
    assert.equal(observations.filter((item) => item.phase === 'warmup').length, 6)
    assert.equal(observations.filter((item) => item.phase === 'measured').length, 36)
    assert(observations.every((item) => item.complete === true))
    assert(observations.filter((item) => item.phase === 'warmup').every((item) => item.timing === null && item.derivedTiming === null))
    const contrasts = {}
    for (const metric of ['cpuMs', 'wallMs']) {
        contrasts[metric] = {
            BoverA: contrast(observations, 'B', 'A', metric),
            BoverC: contrast(observations, 'B', 'C', metric),
            CoverA: contrast(observations, 'C', 'A', metric),
        }
    }
    const {BoverA, BoverC, CoverA} = contrasts.cpuMs
    const checks = {
        BoverAMedianSaving: BoverA.medianSavingUnits >= gate.minimumMedianPairedCpuSavingMs * 1000,
        BoverCMedianSaving: BoverC.medianSavingUnits >= gate.minimumMedianPairedCpuSavingMs * 1000,
        BoverAMedianReduction: percentageAtMost(BoverA.medianPercentFraction, -gate.minimumMedianPairedCpuReductionPercent),
        BoverCMedianReduction: percentageAtMost(BoverC.medianPercentFraction, -gate.minimumMedianPairedCpuReductionPercent),
        BoverAFasterPairs: BoverA.fasterPairs >= gate.minimumFasterPairsAgainstEachControl,
        BoverCFasterPairs: BoverC.fasterPairs >= gate.minimumFasterPairsAgainstEachControl,
        controlMedianStable: absolutePercentageAtMost(CoverA.medianPercentFraction, gate.maximumAbsoluteControlPairedMedianPercent),
        controlSummedCpuStable: absolutePercentageAtMost(CoverA.summedRatioFraction, gate.maximumAbsoluteControlSummedCpuRatioPercent),
        allMandatoryObservationChecksPassed: observations.every((item) => item.complete),
    }
    return {complete: true, contrasts, checks, gate,
        nominationGatePassed: Object.values(checks).every(Boolean),
        secondIndependentReplicationStillRequired: true,
        wholeBrowserQualificationStillRequired: true,
        observationsRemoved: 0}
}

function pathWithin(workspace, name) {
    assert(typeof name === 'string' && name.length > 0 && !isAbsolute(name))
    const location = resolve(workspace, name)
    const child = relative(workspace, location)
    assert(child !== '..' && !child.startsWith('../'))
    return location
}

async function verifyKitFiles(workspace, plan) {
    assert(Array.isArray(plan.commonDriver.files) && plan.commonDriver.files.length > 0)
    const seen = new Set()
    for (const entry of plan.commonDriver.files) {
        assert(!seen.has(entry.path))
        seen.add(entry.path)
        const location = pathWithin(workspace, entry.path)
        const details = await lstat(location)
        assert(details.isFile() && !details.isSymbolicLink())
        assert.equal(createHash('sha256').update(await readFile(location)).digest('hex'), entry.sha256)
    }
    assert(seen.has(plan.commonDriver.relativeEntry))
    assert(seen.has(plan.commonDriver.relativeReceiptAdapter))
}

async function requireSealedPlan(plan, workspace) {
    assert.equal(plan.schemaVersion, 1)
    assert.equal(plan.status, 'sealed', 'Source/harness is still unsealed; no acquisition is authorized')
    assert.equal(plan.acquisitionAuthorized, true, 'Acquisition remains disabled')
    assert.deepEqual(plan.nominationGate, selectedGate)
    assert.equal(plan.numericPolicyStatus, 'selected-prospectively-before-observations')
    assert.equal(plan.runtimePolicy.status, 'sealed')
    assert(plan.expectedWork && /^[0-9a-f]{64}$/.test(plan.expectedOutputDigest))
    assert(Array.isArray(plan.mandatoryCheckNames) && plan.mandatoryCheckNames.length > 0)
    assert(plan.preparationReceipt && plan.workflowBinding)
    for (const arm of ['A', 'B', 'C']) {
        assert(/^[0-9a-f]{40}$/.test(plan.arms[arm].commit))
        assert(/^[0-9a-f]{40}$/.test(plan.arms[arm].tree))
        assert(/^[0-9a-f]{64}$/.test(plan.arms[arm].preparedRuntimeDigest))
        assert(Object.hasOwn(plan.expectedWork, arm))
    }
    assert.equal(process.version, plan.nodeVersion)
    assert.equal(process.env.GITHUB_ACTIONS, 'true', 'This prospective acquisition is hosted only')
    assert.equal(process.env.GITHUB_RUN_ATTEMPT, '1', 'No retry or replacement acquisition')
    assert.deepEqual(process.execArgv, [])
    assert.equal(process.env.NODE_OPTIONS, undefined)
    assert.equal(process.env.NODE_COMPILE_CACHE, undefined)
    assert(availableParallelism() >= plan.runtimePolicy.minimumAllowedLogicalCpus)
    assert.equal(plan.replications.length, 2)
    const first = plan.replications[0].blocks.join('')
    assert.equal(plan.replications[1].blocks.join(''), [...first].reverse().join(''))
    for (const replication of plan.replications) schedule(replication)
    await verifyKitFiles(workspace, plan)
}

export async function acquire(planPath, workspaceArgument, replicationId, outputArgument) {
    const planBytes = await readFile(resolve(planPath))
    const plan = JSON.parse(planBytes)
    const workspace = resolve(workspaceArgument)
    await requireSealedPlan(plan, workspace)
    const replication = plan.replications.find((item) => item.id === replicationId)
    assert(replication, 'Unknown replication')
    const rows = schedule(replication)
    const output = resolve(outputArgument)
    await mkdir(output, {recursive: false})
    await mkdir(resolve(output, 'observations'))
    await mkdir(resolve(output, 'logs'))
    await writeFile(resolve(output, 'frozen-plan.json'), planBytes, {flag: 'wx'})
    const affinity = (await readFile('/proc/self/status', 'utf8')).match(/^Cpus_allowed_list:\s*(.*)$/m)?.[1]
    assert(affinity)
    const state = {complete: false, acquisition: 'new-complete-node-import-cpu-screen',
        replication: replication.id, node: process.version, affinity,
        planSha256: createHash('sha256').update(planBytes).digest('hex'),
        githubRunId: process.env.GITHUB_RUN_ID ?? null, githubJob: process.env.GITHUB_JOB ?? null,
        schedule: rows, observations: []}
    const save = () => writeFile(resolve(output, 'acquisition.json'), JSON.stringify(state, null, 2) + '\n')
    const adapterPath = pathWithin(workspace, plan.commonDriver.relativeReceiptAdapter)
    const {validatePreparedInputs, validateObservation} = await import(pathToFileURL(adapterPath).href)
    assert.equal(typeof validatePreparedInputs, 'function')
    assert.equal(typeof validateObservation, 'function')
    const environment = {...process.env, NODE_DISABLE_COMPILE_CACHE: '1',
        MANABITAN_RECORD_CPU_SCREEN_PLAN: resolve(output, 'frozen-plan.json')}
    for (const name of plan.runtimePolicy.removeEnvironmentOptions) delete environment[name]
    try {
        await save()
        for (const entry of rows) {
            await verifyKitFiles(workspace, plan)
            const prepared = await validatePreparedInputs({plan, workspace, arm: entry.arm,
                mode: entry.mode, replication: replication.id})
            assert.equal(prepared.passed, true)
            assert.equal(prepared.sourceCommit, plan.arms[entry.arm].commit)
            assert.equal(prepared.sourceTree, plan.arms[entry.arm].tree)
            assert.equal(prepared.preparedRuntimeDigest, plan.arms[entry.arm].preparedRuntimeDigest)
            assert.equal(prepared.fixtureSha256, plan.fixture.sha256)
            const name = `${String(entry.index).padStart(3, '0')}-${entry.phase}-${entry.arm}`
            const directory = resolve(output, 'observations', name)
            const stdout = openSync(resolve(output, 'logs', name + '.stdout.txt'), 'wx')
            const stderr = openSync(resolve(output, 'logs', name + '.stderr.txt'), 'wx')
            const attempted = {...entry, name, complete: false, timing: null, derivedTiming: null}
            state.observations.push(attempted)
            await save()
            console.log(JSON.stringify({replication: replication.id, index: entry.index, phase: entry.phase, arm: entry.arm}))
            let result
            try {
                result = spawnSync(process.execPath, [
                    pathWithin(workspace, plan.commonDriver.relativeEntry),
                    pathWithin(workspace, plan.arms[entry.arm].relativeRoot), plan.fixture.dictionary,
                    pathWithin(workspace, plan.fixture.relativePath), directory,
                    entry.arm, plan.arms[entry.arm].commit, entry.mode,
                ], {env: environment, stdio: ['ignore', stdout, stderr],
                    timeout: plan.runtimePolicy.perObservationTimeoutMs})
            } finally {
                closeSync(stdout)
                closeSync(stderr)
            }
            Object.assign(attempted, {exitCode: result.status, signal: result.signal,
                processError: result.error ? String(result.error) : null})
            await save()
            assert.equal(result.status, 0, 'Original process failure is retained; no replacement')
            const receipt = await validateObservation({plan, workspace, directory, arm: entry.arm,
                mode: entry.mode, replication: replication.id})
            assert.equal(receipt.complete, true)
            assert.equal(receipt.arm, entry.arm)
            assert.equal(receipt.mode, entry.mode)
            assert.equal(receipt.sourceCommit, plan.arms[entry.arm].commit)
            assert.equal(receipt.sourceTree, plan.arms[entry.arm].tree)
            assert.equal(receipt.preparedRuntimeDigest, plan.arms[entry.arm].preparedRuntimeDigest)
            assert.equal(receipt.outputDigest, plan.expectedOutputDigest)
            assert.deepEqual(receipt.work, plan.expectedWork[entry.arm])
            assert.deepEqual(Object.keys(receipt.checks).sort(), [...plan.mandatoryCheckNames].sort())
            assert(Object.values(receipt.checks).every((value) => value === true))
            assert.equal(receipt.affinity, affinity)
            if (entry.mode === 'untimed') assert.equal(receipt.timing, null)
            const derivedTiming = entry.mode === 'untimed' ? null : clockValues(receipt.timing)
            Object.assign(attempted, {complete: true, timing: receipt.timing, derivedTiming,
                outputDigest: receipt.outputDigest, work: receipt.work, checks: receipt.checks})
            await save()
        }
        const summary = summarizeReplication(state.observations, plan.nominationGate)
        await writeFile(resolve(output, 'summary.json'), JSON.stringify({...summary, replication: replication.id}, null, 2) + '\n', {flag: 'wx'})
        state.complete = true
        state.nominationGatePassed = summary.nominationGatePassed
    } catch (error) {
        state.error = String(error)
        state.stack = error.stack
        throw error
    } finally {
        await save()
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    assert.equal(process.argv.length, 6, 'Usage: node screen.mjs PLAN WORKSPACE R1|R2 FRESH_OUTPUT')
    await acquire(...process.argv.slice(2))
}
