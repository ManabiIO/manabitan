/* SPDX-License-Identifier: GPL-3.0-or-later */
import {readFileSync, writeFileSync} from 'node:fs'
import {createHash} from 'node:crypto'

function auditCrcLoggedTotals(log) {
    const fail = (message) => { throw new Error(message) }
    const records = []
    for (const [index, raw] of log.split(/\r?\n/).entries()) {
        const start = raw.indexOf('{')
        if (start < 0) continue
        try {
            const value = JSON.parse(raw.slice(start))
            if (value && typeof value === 'object') records.push({line: index + 1, value})
        } catch {}
    }
    const loggedArms = records.filter(({value}) => typeof value.armId === 'string' && Object.hasOwn(value, 'firstPassMs'))
    const expected = [
        'treatment-01-A', 'treatment-01-B', 'control-01-A', 'control-01-C',
        'control-02-C', 'control-02-A', 'treatment-02-B', 'treatment-02-A',
        'treatment-03-A', 'treatment-03-B', 'control-03-A', 'control-03-C',
        'control-04-C', 'control-04-A', 'treatment-04-B', 'treatment-04-A',
        'treatment-05-A', 'treatment-05-B', 'control-05-A', 'control-05-C',
        'control-06-C', 'control-06-A', 'treatment-06-B', 'treatment-06-A'
    ]
    if (loggedArms.length !== 24) fail('Expected 24 complete per-arm totals; observed ' + loggedArms.length)
    for (let index = 0; index < expected.length; index++) {
        const value = loggedArms[index].value
        if (value.armId !== expected[index]) fail('Missing, duplicate, or out-of-order arm at ' + index)
        if (value.passed !== true) fail('Incomplete arm ' + value.armId)
        for (const key of ['firstPassMs', 'secondPassMs', 'initializationWallMs']) {
            if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) fail('Invalid time ' + key + ' for ' + value.armId)
        }
    }
    const finals = records.filter(({value}) => value.passed === true && value.observations === 24 && value.measuredGroups === 576 && Array.isArray(value.cells))
    if (finals.length !== 1) fail('Expected exactly one final complete aggregate')
    if (finals[0].line <= loggedArms.at(-1).line) fail('Aggregate precedes the final arm')

    const one = (predicate, description) => {
        const matches = records.filter(({value}) => predicate(value))
        if (matches.length !== 1) fail('Expected one logged ' + description + ' receipt')
        return matches[0]
    }
    const buildGate = one(value => typeof value.sourceCommit === 'string' && value.variants, 'build')
    if (buildGate.value.passed !== true || buildGate.value.sourceCommit !== '887884769ad1b7d54872975920fc0f8fd43a56ee') fail('Wrong logged build identity')
    for (const [variant, expectedHash, expectedSize] of [
        ['baseline', '8ae00698649c5a3e41039b13c5ffe1dff2d4e69948cba2e3c063f381250031ee', 67659],
        ['candidate', '1d0990753b18591d0befd2be35e6fc5a7ba9ae93e48e883184d13f01fe0526e8', 66638]
    ]) {
        const value = buildGate.value.variants[variant]
        if (value?.wasmSha256 !== expectedHash || value?.wasmBytes !== expectedSize) fail('Wrong logged module ' + variant)
    }
    const captureGate = one(value => value.dictionary === 'jmdict' && Object.hasOwn(value, 'allImmediateCrc'), 'capture')
    for (const [key, value] of Object.entries({groups:12,banks:53,rows:528299,compressedBytes:15632849,decodedBytes:171617523,allImmediateCrc:true})) {
        if (captureGate.value[key] !== value) fail('Wrong capture ' + key)
    }
    const correctnessGate = one(value => Object.hasOwn(value, 'crcVectors') && Object.hasOwn(value, 'productionConformance'), 'correctness')
    for (const [key, value] of Object.entries({passed:true,crcVectors:837,productionConformance:157,fullJmdictGroups:12,rows:528299,decodedBytes:171617523})) {
        if (correctnessGate.value[key] !== value) fail('Wrong correctness ' + key)
    }
    if (!(buildGate.line < captureGate.line && captureGate.line < correctnessGate.line && correctnessGate.line < loggedArms[0].line)) fail('Unexpected gate/timing order')

    const byId = new Map(loggedArms.map(record => [record.value.armId, record.value]))
    const median6 = (values) => {
        if (values.length !== 6) fail('Expected six paired values')
        const sorted = values.slice().sort((a, b) => a - b)
        return (sorted[2] + sorted[3]) / 2
    }
    const cells = []
    for (const scenario of ['treatment', 'control']) {
        for (const phase of ['first-pass', 'second-pass', 'startup-plus-first-pass']) {
            const pairs = []
            for (let pair = 1; pair <= 6; pair++) {
                const prefix = scenario + '-' + String(pair).padStart(2, '0') + '-'
                const baseline = byId.get(prefix + 'A')
                const compared = byId.get(prefix + (scenario === 'treatment' ? 'B' : 'C'))
                const value = (arm) => phase === 'first-pass' ? arm.firstPassMs :
                    phase === 'second-pass' ? arm.secondPassMs : arm.firstPassMs + arm.initializationWallMs
                const baselineMs = value(baseline)
                const comparedMs = value(compared)
                pairs.push({pair, baselineArmId: baseline.armId, comparedArmId: compared.armId,
                    baselineMs, comparedMs, ratio: comparedMs / baselineMs, deltaMs: comparedMs - baselineMs})
            }
            let baselineSumMs = 0
            let comparedSumMs = 0
            for (const pair of pairs) { baselineSumMs += pair.baselineMs; comparedSumMs += pair.comparedMs }
            const cell = {scenario, phase, pairs, baselineSumMs, comparedSumMs,
                medianRatio: median6(pairs.map(pair => pair.ratio)),
                equalWorkRatio: comparedSumMs / baselineSumMs,
                medianDeltaMs: median6(pairs.map(pair => pair.deltaMs)),
                fasterPairs: pairs.filter(pair => pair.comparedMs < pair.baselineMs).length}
            const matches = finals[0].value.cells.filter(other => other.scenario === scenario && other.phase === phase)
            if (matches.length !== 1) fail('Missing or duplicate final cell')
            const stated = matches[0]
            for (const key of ['medianRatio', 'equalWorkRatio']) {
                if (typeof stated[key] !== 'number' || Math.abs(stated[key] - cell[key]) > 1e-12) fail('Aggregate mismatch ' + scenario + '/' + phase + '/' + key)
            }
            if (stated.fasterPairs !== cell.fasterPairs) fail('Win count mismatch')
            cells.push(cell)
        }
    }
    if (finals[0].value.cells.length !== 6) fail('Unexpected final cells')
    return {scope: 'Independent arithmetic and exact schedule audit of complete CI per-arm logged totals only. No independent per-group artifact, decoded output, module, or memory audit is claimed.',
        expectedRun: 46120623371, expectedResearchCommit: '887884769ad1b7d54872975920fc0f8fd43a56ee',
        loggedGateEvidence: {buildGate, captureGate, correctnessGate},
        gateEvidenceScope: 'Frozen-job logged assertions are bound and ordered; module and full output bytes are not independently rehashed by this log-only audit.',
        loggedArms, finalAggregateLine: finals[0].line, completeArmTotals: 24,
        declaredMeasuredGroups: 576, independentRawGroupAudit: false, cells}
}
const [logPath, outputPath] = process.argv.slice(2)
if (!logPath) throw new Error('Usage: node audit-logged-totals.mjs JOB_LOG [OUTPUT_JSON]')
const bytes = readFileSync(logPath)
const decodedLogSha256 = createHash('sha256').update(bytes).digest('hex')
if (decodedLogSha256 !== '63bf261b087d4e821b230ea4f497602ad6b8f9e55c86adb948287ff862d6ea6f') throw new Error('Wrong original decoded job log bytes')
const result = auditCrcLoggedTotals(bytes.toString('utf8'))
result.decodedLogSha256 = decodedLogSha256
result.decodedLogBytes = bytes.length
const serialized = JSON.stringify(result, null, 2) + '\n'
if (outputPath) writeFileSync(outputPath, serialized, {flag: 'wx'})
else process.stdout.write(serialized)
