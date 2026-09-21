/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {cpus} from 'node:os'
import {performance} from 'node:perf_hooks'
import {resolve} from 'node:path'
import {pathToFileURL} from 'node:url'

/** @typedef {typeof import('../../ext/js/dictionary/term-record-preinterned-plan.js')} PlanModule */
const options = new Map(process.argv.slice(2).map((arg) => {
    const match = /^--([^=]+)=(.+)$/.exec(arg)
    assert.ok(match, `Expected --name=value: ${arg}`)
    return [match[1], match[2]]
}))
for (const key of options.keys()) {
    assert.ok(['baseline', 'candidate', 'output', 'rounds', 'iterations'].includes(key), `Unknown option: ${key}`)
}
const baseline = options.get('baseline')
const candidate = options.get('candidate')
const output = options.get('output')
assert.ok(baseline && candidate && output, '--baseline, --candidate and --output are required')
const rounds = Number(options.get('rounds') ?? 9)
const iterations = Number(options.get('iterations') ?? 6)
assert.ok(Number.isSafeInteger(rounds) && rounds >= 3 && rounds <= 101)
assert.ok(Number.isSafeInteger(iterations) && iterations > 0 && iterations <= 100)
const aURL = pathToFileURL(resolve(baseline))
const bURL = pathToFileURL(resolve(candidate))
/** @type {PlanModule} */
const a = await import(aURL.href)
/** @type {PlanModule} */
const b = await import(bURL.href)
const gc = globalThis.gc
assert.ok(gc, 'Run with node --expose-gc')

/** @param {number[]} values @returns {number} */
function median(values) {
    const sorted = [...values].sort((x, y) => x - y)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** @param {number} length @param {number} seed @returns {Uint32Array} */
function permutation(length, seed) {
    const values = Uint32Array.from({length}, (_, i) => i)
    for (let i = length - 1; i > 0; --i) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        const j = seed % (i + 1)
        const value = values[i]
        values[i] = values[j]
        values[j] = value
    }
    return values
}

/** @param {string} mode @param {number} width @returns {import('../../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} @throws {Error} If the workload mode is unknown. */
function makePlan(mode, width) {
    const keyCount = 90000
    const rowCount = 30000
    const stringLengths = Uint16Array.from({length: keyCount}, (_, i) => width + i % 7)
    const stringOffsets = new Uint32Array(keyCount)
    let byteLength = 0
    for (let i = 0; i < keyCount; ++i) {
        stringOffsets[i] = byteLength
        byteLength += stringLengths[i]
    }
    const stringsBuffer = new Uint8Array(byteLength)
    for (let i = 0; i < byteLength; ++i) { stringsBuffer[i] = (Math.imul(i, 17) + (i >>> 7)) & 255 }
    const shuffled = permutation(keyCount, 0x71a9d6b5)
    const shuffledGroups = permutation(Math.floor(keyCount / 8), 0x118de902)
    const expressionIndexes = new Uint32Array(rowCount)
    const readingIndexes = new Uint32Array(rowCount)
    for (let i = 0; i < rowCount; ++i) {
        switch (mode) {
            case 'contiguous':
                expressionIndexes[i] = i + 15000
                readingIndexes[i] = expressionIndexes[i]
                break
            case 'runs-of-eight':
                expressionIndexes[i] = shuffledGroups[Math.floor(i / 8)] * 8 + i % 8
                readingIndexes[i] = expressionIndexes[i]
                break
            case 'shuffled':
                expressionIndexes[i] = shuffled[i]
                readingIndexes[i] = expressionIndexes[i]
                break
            case 'two-regions':
                expressionIndexes[i] = i
                readingIndexes[i] = i + 45000
                break
            case 'repeated':
                expressionIndexes[i] = shuffled[i % 256]
                readingIndexes[i] = shuffled[(i * 7) % 512]
                break
            default: throw new Error(`Unknown workload ${mode}`)
        }
    }
    return {stringLengths, stringOffsets, stringsBuffer, expressionIndexes, readingIndexes}
}

const results = []
/** @type {[string, string, number][]} */
const workloads = [
    ['contiguous-short', 'contiguous', 16],
    ['local-runs-eight', 'runs-of-eight', 16],
    ['shuffled-control', 'shuffled', 16],
    ['two-regions-control', 'two-regions', 16],
    ['repeated-keys-control', 'repeated', 16],
    ['contiguous-long', 'contiguous', 512],
]
for (const [name, mode, width] of workloads) {
    const plan = makePlan(mode, width)
    const rowCount = plan.expressionIndexes.length
    const scratchA = new Uint32Array(plan.stringLengths.length)
    const scratchB = new Uint32Array(plan.stringLengths.length)
    const reference = a.compactTermRecordPreinternedPlan(plan, 0, rowCount, scratchA)
    const actual = b.compactTermRecordPreinternedPlan(plan, 0, rowCount, scratchB)
    assert.ok(reference && actual)
    assert.deepEqual(actual, reference)
    assert.ok(scratchA.every((x) => x === 0) && scratchB.every((x) => x === 0))
    const digest = createHash('sha256')
    for (const value of Object.values(reference)) {
        if (ArrayBuffer.isView(value)) { digest.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) }
    }
    /** @param {PlanModule} module @param {Uint32Array} scratch @returns {number} */
    function run(module, scratch) {
        let checksum = 0
        for (let i = 0; i < iterations; ++i) {
            const result = module.compactTermRecordPreinternedPlan(plan, 0, rowCount, scratch)
            assert.ok(result)
            checksum += result.stringsBuffer.length + result.stringsBuffer[0] + result.stringsBuffer[result.stringsBuffer.length - 1]
            checksum += result.expressionIndexes[rowCount - 1] + result.readingIndexes[Math.floor(rowCount / 2)]
        }
        return checksum
    }
    const expectedChecksum = run(a, scratchA)
    for (let i = 0; i < 6; ++i) {
        assert.equal(run(a, scratchA), expectedChecksum)
        assert.equal(run(b, scratchB), expectedChecksum)
    }
    const pairs = []
    const samples = []
    for (let block = 0; block < rounds; ++block) {
        const order = block % 2 === 0 ? ['A', 'B', 'B', 'A'] : ['B', 'A', 'A', 'B']
        /** @type {Record<string, number[]>} */
        const times = {A: [], B: []}
        for (const variant of order) {
            if (gc) { gc() }
            const start = performance.now()
            const checksum = variant === 'A' ? run(a, scratchA) : run(b, scratchB)
            const ms = performance.now() - start
            assert.equal(checksum, expectedChecksum)
            times[variant].push(ms)
            samples.push({block, variant, ms, checksum})
        }
        const baselineMs = (times.A[0] + times.A[1]) / 2
        const candidateMs = (times.B[0] + times.B[1]) / 2
        pairs.push({block, baselineMs, candidateMs, deltaPercent: (candidateMs / baselineMs - 1) * 100})
    }
    const result = {
        name, mode, width, rowCount, keyCount: plan.stringLengths.length, arenaBytes: plan.stringsBuffer.length,
        outputSha256: digest.digest('hex'), expectedChecksum,
        baselineMs: median(pairs.map((p) => p.baselineMs)), candidateMs: median(pairs.map((p) => p.candidateMs)),
        medianPairedDeltaPercent: median(pairs.map((p) => p.deltaPercent)),
        fasterBlocks: pairs.filter((p) => p.deltaPercent < 0).length, pairs, samples,
    }
    results.push(result)
    console.log(`${name}: ${result.medianPairedDeltaPercent.toFixed(2)}%, ${result.fasterBlocks}/${rounds} faster blocks`)
}
/** @param {URL} url @returns {Promise<string>} */
const sourceHash = async (url) => createHash('sha256').update(await readFile(url)).digest('hex')
await writeFile(resolve(output), `${JSON.stringify({
    schemaVersion: 1, syntheticOnly: true, node: process.version, v8: process.versions.v8,
    platform: process.platform, arch: process.arch, cpu: cpus()[0].model, rounds, iterations,
    boundary: 'Complete production plan compaction, including source validation, row remapping, output allocation and byte copying; not an import',
    methodology: 'Six paired warmups, alternating ABBA/BAAB blocks, GC before timing, full parity outside timing and consumed checksums inside',
    baselineSha256: await sourceHash(aURL), candidateSha256: await sourceHash(bURL), harnessSha256: await sourceHash(new URL(import.meta.url)),
    results,
}, null, 2)}\n`)
