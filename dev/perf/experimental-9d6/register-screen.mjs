/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {deserialize} from 'node:v8'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {join, resolve} from 'node:path'
import {gunzipSync} from 'node:zlib'
import os from 'node:os'

const [baselineInput, candidateInput, captureInput, output, mode = 'warm', order = 'AB'] = process.argv.slice(2)
assert(baselineInput && candidateInput && captureInput && output)
assert(['warm', 'cold-A', 'cold-B', 'cold-C'].includes(mode))
assert(order === 'AB' || order === 'BA')
const baseline = resolve(baselineInput)
const candidate = resolve(candidateInput)
const capture = resolve(captureInput)
const repetitions = 16
assert.equal(typeof global.gc, 'function', 'Run with --expose-gc')
// These roots are explicitly chosen by the local experiment entrypoint.
// eslint-disable-next-line no-unsanitized/method
const load = async (root) => import(pathToFileURL(join(root, 'ext/js/dictionary/dictionary-database.js')))
const {DictionaryDatabase: Base} = await load(baseline)
const {DictionaryDatabase: Candidate} = await load(candidate)
const hash = async (root) => createHash('sha256').update(await readFile(join(root, 'ext/js/dictionary/dictionary-database.js'))).digest('hex')
const captureBytes = await readFile(join(capture, 'report.json'))
const captureReport = JSON.parse(captureBytes)
assert.equal(captureReport.complete, true)
assert.equal(captureReport.dictionary, 'jmdict')
assert.equal(captureReport.fixture.sha256, '3a614c92cfa747946de8422fc408d6d93926ba76541df66e434b24976a10160f')
assert.equal(captureReport.databaseSourceSha256, await hash(baseline))
const captureReportSha256 = createHash('sha256').update(captureBytes).digest('hex')
const scriptSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex')
const groups = []
const spanFactory = new Candidate()
const loadGroup = async (receipt) => {
    const name = receipt.cacheFile
    assert(/^group-\d+\.bin\.gz$/.test(name))
    const file = await readFile(join(capture, name))
    assert.equal(createHash('sha256').update(file).digest('hex'), receipt.cacheSha256)
    const bytes = gunzipSync(file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.serializedSha256)
    const group = deserialize(bytes)
    assert(group.persistedOffsets instanceof Float64Array && group.persistedLengths instanceof Uint32Array)
    assert.deepEqual(group.persistedLengths, group.lengths)
    const buffer = new Uint8Array(new SharedArrayBuffer(group.source.byteLength))
    buffer.set(group.source)
    const spans = {buffer, offsets: new Uint32Array(group.offsets), lengths: new Uint32Array(group.lengths)}
    groups.push({name, inputSha256: createHash('sha256').update(bytes).digest('hex'),
        offsets: new Float64Array(group.persistedOffsets), lengths: spans.lengths,
        spans, ownedSpans: spanFactory._createTermContentSourceSpans(buffer, spans.offsets, spans.lengths),
        dictName: group.virtualDictName})
}
for (const receipt of captureReport.groups) {
    await loadGroup(receipt)
    global.gc()
}
assert(groups.length > 0)
const rows = groups.reduce((n, g) => n + g.offsets.length, 0)
assert.equal(rows, captureReport.summary.cacheRows)
const inputs = groups.map(({name, inputSha256}) => ({name, inputSha256}))
const preparationExcluded = 'decompression, private metadata copies, shared source byte copies, frozen span container creation; GC before each timed arm'
const metadataShape = 'Pending lengths alias the source lengths, matching _beginAppendSharedSpans; persisted offsets remain virtual sequential addresses'
const sourceSpans = (Ctor, group) => Ctor === Candidate ? group.ownedSpans : group.spans
const run = (Ctor, retain, passes = repetitions) => {
    global.gc()
    const db = new Ctor()
    const start = performance.now()
    for (let repeat = 0; repeat < passes; ++repeat) {
        const active = []
        for (const group of groups) {
            const unregister = db._registerInFlightTermContentSources(group.offsets, group.lengths, group.dictName, [], sourceSpans(Ctor, group))
            active.push(unregister)
            if (active.length > retain) { active.shift()() }
        }
        for (const unregister of active) { unregister() }
    }
    const durationMs = performance.now() - start
    assert.equal(db._inFlightTermContentSourceBatches.size, 0)
    return durationMs / passes
}
const validate = (Ctor) => {
    const db = new Ctor()
    const active = []
    const digest = createHash('sha256')
    for (const group of groups) {
        active.push(db._registerInFlightTermContentSources(group.offsets, group.lengths, group.dictName, [], sourceSpans(Ctor, group)))
        const batch = [...db._inFlightTermContentSourceBatches].at(-1)
        digest.update(JSON.stringify([batch.sortedOffsets, batch.minimumOffset, batch.maximumOffset]))
        for (let i = 0; i < group.offsets.length; ++i) {
            const found = db._findInFlightTermContentSource(group.offsets[i], group.lengths[i], group.dictName)
            assert(found)
            assert.equal(found.buffer, group.spans.buffer)
            assert.equal(found.offset, group.spans.offsets[i])
            assert.equal(found.length, group.spans.lengths[i])
        }
        if (active.length > 2) { active.shift()() }
    }
    for (const unregister of active) { unregister() }
    return digest.digest('hex')
}
if (mode.startsWith('cold-')) {
    const firstCorpusArm = mode.slice(5)
    const Ctor = firstCorpusArm === 'B' ? Candidate : Base
    const durationMs = run(Ctor, 0, 1)
    const report = {boundary: 'first registration pass in a fresh Node process; real source groups, virtual persisted offsets; no browser or OPFS',
        preparationExcluded, metadataShape, captureReportSha256, scriptSha256, order, inputs,
        arm: firstCorpusArm, retain: 0, durationMs, entries: rows, groupCount: groups.length,
        host: {node: process.version, v8: process.versions.v8, cpus: os.availableParallelism(), load: os.loadavg()},
        baseline, candidate, baselineSourceSha256: await hash(baseline), candidateSourceSha256: await hash(candidate),
        outputDigestCheckedAfterTiming: validate(Ctor)}
    await writeFile(output, JSON.stringify(report, null, 2) + '\n')
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    process.exit(0)
}
const outputA = validate(Base)
assert.equal(validate(Candidate), outputA)
const reach = [0, 2].map((retain) => {
    const db = new Candidate()
    const active = []
    let admittedGroups = 0
    let admittedRows = 0
    for (const group of groups) {
        const range = db._getDisjointTermContentSpanRange(group.offsets, group.lengths, group.dictName, group.ownedSpans, group.offsets.length)
        if (range !== null) {
            ++admittedGroups
            admittedRows += group.offsets.length
        }
        active.push(db._registerInFlightTermContentSources(group.offsets, group.lengths, group.dictName, [], group.ownedSpans))
        if (active.length > retain) { active.shift()() }
    }
    for (const unregister of active) { unregister() }
    assert.equal(admittedRows, rows)
    return {retain, admittedGroups, admittedRows}
})
const schedules = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC']
if (order === 'BA') { schedules.reverse() }
const observations = []
for (const retain of [0, 2]) {
    for (let warmup = 0; warmup < 3; ++warmup) {
        for (const arm of order) { run(arm === 'B' ? Candidate : Base, retain) }
    }
    for (let block = 0; block < schedules.length; ++block) {
        for (const arm of schedules[block]) {
            const durationMs = run(arm === 'B' ? Candidate : Base, retain)
            observations.push({retain, block, arm, durationMs})
            process.stderr.write(`${retain} ${block} ${arm} ${durationMs.toFixed(3)}ms\n`)
        }
    }
}
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const summary = [0, 2].map((retain) => {
    const ratios = []
    const controls = []
    const differences = []
    for (let block = 0; block < schedules.length; ++block) {
        const cell = Object.fromEntries(observations.filter((x) => x.retain === retain && x.block === block).map((x) => [x.arm, x.durationMs]))
        ratios.push(cell.B / cell.A - 1)
        controls.push(cell.C / cell.A - 1)
        differences.push(cell.B - cell.A)
    }
    return {retain, topology: retain === 0 ? 'production topology: no prior active batch' : 'synthetic stress: two prior active batches',
        pairedMedianPercent: median(ratios) * 100, sameCodeControlPercent: median(controls) * 100,
        pairedMedianMs: median(differences), fasterPairs: differences.filter((v) => v < 0).length,
        medians: Object.fromEntries(['A', 'B', 'C'].map((arm) => [arm, median(observations.filter((x) => x.retain === retain && x.arm === arm).map((x) => x.durationMs))]))}
})
const report = {boundary: 'synchronous registration only; real source spans and virtual sequential persisted offsets; no compression, browser or OPFS',
    preparationExcluded, metadataShape, captureReportSha256, scriptSha256, order, schedules,
    host: {node: process.version, v8: process.versions.v8, cpus: os.availableParallelism(), load: os.loadavg()},
    baseline, candidate, baselineSourceSha256: await hash(baseline), candidateSourceSha256: await hash(candidate),
    repetitions, entries: rows, groups: inputs, outputA, reach, observations, summary}
await writeFile(output, JSON.stringify(report, null, 2) + '\n')
process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
