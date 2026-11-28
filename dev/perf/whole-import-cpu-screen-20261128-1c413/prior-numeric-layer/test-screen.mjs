// Pure synthetic arithmetic/source-guard checks, never importer observations.
// No clock reader, child process, product module or dictionary is executed.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {acquire, clockValues, schedule, summarizeReplication} from './screen.mjs'

const plan = JSON.parse(readFileSync(new URL('./plan.json', import.meta.url)))
const tests = []
const test = (name, action) => tests.push({name, action})
const repeat = (value) => new Array(12).fill(value)

function rawClock(cpuMicros, wallNs = 500000000) {
    return {cpuBefore: {user: 100, system: 20}, cpuAfter: {user: 100 + cpuMicros, system: 20},
        wallBeforeNs: '1000000000', wallAfterNs: String(1000000000n + BigInt(wallNs)),
        cpuMs: cpuMicros / 1000, wallMs: wallNs / 1e6}
}

function observations(A, B, C) {
    const values = {A, B, C}
    return schedule(plan.replications[0]).map((entry) => {
        const timing = entry.phase === 'warmup' ? null : rawClock(values[entry.arm][entry.block])
        return {...entry, complete: true, timing,
            derivedTiming: timing === null ? null : clockValues(timing)}
    })
}

function evaluate(A, B, C) {
    return summarizeReplication(observations(A, B, C), plan.nominationGate)
}

test('all prescribed permutations and positions are balanced within blocks', () => {
    for (const replication of plan.replications) {
        const rows = schedule(replication)
        assert.equal(rows.length, 42)
        assert.equal(rows.filter((row) => row.phase === 'warmup' && row.mode === 'untimed').length, 6)
        const measured = rows.filter((row) => row.phase === 'measured')
        for (const arm of 'ABC') {
            assert.deepEqual([0, 1, 2].map((position) => measured.filter((row) => row.arm === arm && row.position === position).length), [4, 4, 4])
        }
        const edges = Object.fromEntries(['AB', 'AC', 'BA', 'BC', 'CA', 'CB'].map((key) => [key, 0]))
        for (const order of replication.blocks) {
            ++edges[order.slice(0, 2)]
            ++edges[order.slice(1, 3)]
        }
        assert(Object.values(edges).every((value) => value === 4))
    }
    assert.equal(plan.replications[1].blocks.join(''), [...plan.replications[0].blocks.join('')].reverse().join(''))
})

test('exact 20ms and 1percent candidate boundaries pass independently', () => {
    const result = evaluate(repeat(2000000), repeat(1980000), repeat(2000000))
    assert.equal(result.nominationGatePassed, true)
    assert.equal(result.contrasts.cpuMs.BoverA.medianSaving, 20)
    assert.equal(result.contrasts.cpuMs.BoverA.medianPercent, -1)
})

test('one microsecond under the absolute benefit floor fails', () => {
    const result = evaluate(repeat(1000000), repeat(980001), repeat(1000000))
    assert.equal(result.checks.BoverAMedianReduction, true)
    assert.equal(result.checks.BoverAMedianSaving, false)
    assert.equal(result.nominationGatePassed, false)
})

test('one microsecond under the relative benefit floor fails', () => {
    const result = evaluate(repeat(4000000), repeat(3960001), repeat(4000000))
    assert.equal(result.checks.BoverAMedianSaving, true)
    assert.equal(result.checks.BoverAMedianReduction, false)
    assert.equal(result.nominationGatePassed, false)
})

test('both controls must pass with no pooled substitute', () => {
    const result = evaluate(repeat(2000000), repeat(1960000), repeat(1970000))
    assert.equal(result.checks.BoverAMedianSaving, true)
    assert.equal(result.checks.BoverAMedianReduction, true)
    assert.equal(result.checks.BoverCMedianSaving, false)
    assert.equal(result.checks.BoverCMedianReduction, false)
    assert.equal(result.checks.controlMedianStable, true)
    assert.equal(result.nominationGatePassed, false)
})

test('exact plus and minus 3percent paired and summed controls pass', () => {
    for (const control of [1030000, 970000]) {
        const result = evaluate(repeat(1000000), repeat(900000), repeat(control))
        assert.equal(result.checks.controlMedianStable, true)
        assert.equal(result.checks.controlSummedCpuStable, true)
        assert.equal(result.nominationGatePassed, true)
    }
})

test('one microsecond beyond either signed control boundary fails', () => {
    for (const control of [1030001, 969999]) {
        const result = evaluate(repeat(1000000), repeat(900000), repeat(control))
        assert.equal(result.checks.controlMedianStable, false)
        assert.equal(result.checks.controlSummedCpuStable, false)
    }
})

test('exact summed control boundary passes while one unit beyond fails', () => {
    for (const [last, outside] of [[1360000, 1360001], [640000, 639999]]) {
        const exact = evaluate(repeat(1000000), repeat(800000), [...new Array(11).fill(1000000), last])
        assert.equal(exact.checks.controlMedianStable, true)
        assert.equal(exact.checks.controlSummedCpuStable, true)
        const changed = evaluate(repeat(1000000), repeat(800000), [...new Array(11).fill(1000000), outside])
        assert.equal(changed.checks.controlMedianStable, true)
        assert.equal(changed.checks.controlSummedCpuStable, false)
    }
})

test('no obsolete absolute millisecond control gate survives', () => {
    const result = evaluate(repeat(1000000), repeat(950000), repeat(1020000))
    assert.equal(Math.abs(result.contrasts.cpuMs.CoverA.medianSaving), 20)
    assert.equal(result.nominationGatePassed, true)
    assert.equal(plan.nominationGate.absoluteControlMillisecondGate, null)
})

test('ten faster pairs pass and nine fail; ties are not faster', () => {
    const ten = evaluate(repeat(1000000), [...new Array(10).fill(950000), 1000000, 1000000], repeat(1000000))
    assert.equal(ten.contrasts.cpuMs.BoverA.fasterPairs, 10)
    assert.equal(ten.nominationGatePassed, true)
    const nine = evaluate(repeat(1000000), [...new Array(9).fill(950000), 1000000, 1000000, 1000000], repeat(1000000))
    assert.equal(nine.checks.BoverAMedianSaving, true)
    assert.equal(nine.checks.BoverAFasterPairs, false)
    assert.equal(nine.nominationGatePassed, false)
})

test('median paired percentage is not a ratio of arm medians', () => {
    const A = [...new Array(6).fill(1000000), ...new Array(6).fill(4000000)]
    const B = [...new Array(6).fill(980000), ...new Array(6).fill(3900000)]
    const result = evaluate(A, B, A)
    assert.equal(result.contrasts.cpuMs.BoverA.medianPercent, -2.25)
    assert.equal(result.contrasts.cpuMs.BoverA.medianSaving, 60)
})

test('a fast wall contrast cannot rescue a failed CPU gate', () => {
    const rows = observations(repeat(1000000), repeat(999000), repeat(1000000))
    for (const row of rows.filter((item) => item.phase === 'measured')) {
        row.timing = rawClock(row.derivedTiming.cpuMicros, row.arm === 'B' ? 10000000 : 500000000)
        row.derivedTiming = clockValues(row.timing)
    }
    const result = summarizeReplication(rows, plan.nominationGate)
    assert(result.contrasts.wallMs.BoverA.medianPercent < -90)
    assert.equal(result.nominationGatePassed, false)
})

test('a failed second replication remains failed independently', () => {
    const first = evaluate(repeat(1000000), repeat(950000), repeat(1000000))
    const second = evaluate(repeat(1000000), repeat(999000), repeat(1000000))
    assert.equal(first.nominationGatePassed, true)
    assert.equal(second.nominationGatePassed, false)
    assert.equal(first.nominationGatePassed && second.nominationGatePassed, false)
})

test('missing duplicate failed or timed warmup records are rejected', () => {
    const base = observations(repeat(1000000), repeat(950000), repeat(1000000))
    for (const change of [
        (rows) => rows.pop(),
        (rows) => { rows[7] = {...rows[6]} },
        (rows) => { rows[6].complete = false },
        (rows) => { rows[0].timing = rawClock(1000000) },
    ]) {
        const rows = structuredClone(base)
        change(rows)
        assert.throws(() => summarizeReplication(rows, plan.nominationGate))
    }
})

test('raw process CPU snapshots are recomputed without a wall upper bound', () => {
    const timing = rawClock(200000, 100000000)
    assert.deepEqual(clockValues(timing), {cpuMicros: 200000, cpuMs: 200, wallNs: 100000000, wallMs: 100})
    for (const change of [
        (value) => { value.cpuBefore.user = true },
        (value) => { value.cpuAfter.user = value.cpuBefore.user - 1 },
        (value) => { value.cpuAfter.system += 0.5 },
        (value) => { value.cpuMs += 0.001 },
        (value) => { value.wallAfterNs = value.wallBeforeNs },
        (value) => { value.wallBeforeNs = '01000000000' },
        (value) => { value.wallMs += 0.001 },
    ]) {
        const altered = structuredClone(timing)
        change(altered)
        assert.throws(() => clockValues(altered))
    }
})

test('current unsealed plan rejects before any child or product import', async () => {
    assert.equal(plan.status, 'source-only-unsealed')
    assert.equal(plan.acquisitionAuthorized, false)
    assert.equal(plan.commonDriver.relativeEntry, null)
    assert.equal(plan.commonDriver.relativeReceiptAdapter, null)
    await assert.rejects(acquire(fileURLToPath(new URL('./plan.json', import.meta.url)),
        '/path-that-is-never-opened', 'R1', '/path-that-is-never-created'), /still unsealed/)
})

const results = []
for (const {name, action} of tests) {
    try {
        await action()
        results.push({name, passed: true})
    } catch (error) {
        results.push({name, passed: false, error: String(error)})
    }
}
const sourceSha256 = {}
for (const name of ['plan.json', 'PROTOCOL.md', 'screen.mjs', 'test-screen.mjs']) {
    sourceSha256[name] = createHash('sha256').update(readFileSync(new URL('./' + name, import.meta.url))).digest('hex')
}
const report = {evidenceKind: 'synthetic-arithmetic-and-disabled-guard-checks', node: process.version,
    productCodeLoaded: false, dictionaryImports: 0, childProcessesLaunched: 0, timingAcquired: false,
    sourceSha256, tests: results.length, passed: results.filter((item) => item.passed).length,
    failed: results.filter((item) => !item.passed).length, results}
console.log(JSON.stringify(report, null, 2))
if (report.failed !== 0) process.exitCode = 1
