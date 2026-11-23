import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {performance} from 'node:perf_hooks'
import {crc32} from 'node:zlib'

const inputPath = process.argv[2]
const outputPath = process.argv[3]
assert(inputPath && outputPath, 'Usage: node --expose-gc crc-screen.mjs INPUTS OUTPUT')
assert(typeof globalThis.gc === 'function', 'Use --expose-gc')
assert(typeof process.threadCpuUsage === 'function', 'Thread CPU timing is required')
const inputs = JSON.parse(readFileSync(inputPath, 'utf8'))
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const modules = {}
for (const [label, variant] of Object.entries(inputs.variants)) {
    for (const [filename, expectedHash] of Object.entries(variant.sources)) {
        assert.equal(hash(readFileSync(path.join(variant.root, filename))), expectedHash, `Changed ${label} source`)
    }
    const bytes = readFileSync(variant.testModulePath)
    assert.equal(hash(bytes), variant.testModuleSha256)
    modules[label] = await WebAssembly.compile(bytes)
}
const corpora = {}
for (const [label, corpus] of Object.entries(inputs.corpora)) {
    corpora[label] = corpus.banks.map((bank) => {
        const bytes = readFileSync(bank.path)
        assert.equal(bytes.length, bank.bytes)
        assert.equal(hash(bytes), bank.sha256)
        assert.equal(crc32(bytes) >>> 0, bank.crc32)
        return {...bank, bytes}
    })
}
const observations = []
const plan = {
    pairsPerCorpusPerComparison: 8,
    comparisons: ['AA', 'AB'],
    warmupsPerObservation: 2,
    minimumBytesPerObservation: 64 * 1024 * 1024,
    alignments: [0, 1, 3],
    boundary: 'CRC-only over resident first/middle/last term banks; excludes archive IO, inflation, allocation, copies, compilation and warmups',
    node: process.version,
    v8: process.versions.v8,
    cpu: os.cpus()[0]?.model,
    availableParallelism: os.availableParallelism(),
    loadBefore: os.loadavg(),
    inputsSha256: hash(readFileSync(inputPath)),
}
writeFileSync(outputPath + '.jsonl', JSON.stringify({plan}) + '\n', {flag: 'wx'})

async function observe(comparison, corpus, pair, arm, variant) {
    const banks = corpora[corpus]
    const instance = await WebAssembly.instantiate(modules[variant])
    const wasm = instance.exports
    wasm.wasm_reset_heap()
    const spans = banks.map((bank, index) => {
        const alignment = plan.alignments[index]
        const pointer = wasm.wasm_alloc(bank.bytes.length + alignment) + alignment
        new Uint8Array(wasm.memory.buffer, pointer, bank.bytes.length).set(bank.bytes)
        return {pointer, length: bank.bytes.length, crc: bank.crc32}
    })
    const bytesPerPass = banks.reduce((sum, bank) => sum + bank.bytes.length, 0)
    const passes = Math.ceil(plan.minimumBytesPerObservation / bytesPerPass)
    const values = new Uint32Array(spans.length)
    const run = () => {
        for (let pass = 0; pass < passes; ++pass) {
            for (let index = 0; index < spans.length; ++index) {
                const span = spans[index]
                values[index] = wasm.term_bank_crc32_test(span.pointer, span.length)
            }
        }
    }
    globalThis.gc()
    for (let warmup = 0; warmup < plan.warmupsPerObservation; ++warmup) run()
    const startCpu = process.threadCpuUsage()
    const start = performance.now()
    run()
    const elapsedMs = performance.now() - start
    const cpu = process.threadCpuUsage(startCpu)
    for (let index = 0; index < spans.length; ++index) assert.equal(values[index], spans[index].crc)
    const observation = {comparison, corpus, pair, arm, variant, passes, bytes: passes * bytesPerPass, elapsedMs, threadCpuMs: (cpu.user + cpu.system) / 1000, crc32: Array.from(values)}
    observations.push(observation)
    appendFileSync(outputPath + '.jsonl', JSON.stringify(observation) + '\n')
}
try {
    for (const comparison of plan.comparisons) {
        for (const corpus of Object.keys(corpora)) {
            for (let pair = 0; pair < plan.pairsPerCorpusPerComparison; ++pair) {
                const order = pair % 2 === 0 ? ['A', 'B'] : ['B', 'A']
                for (const arm of order) {
                    await observe(comparison, corpus, pair, arm, comparison === 'AA' || arm === 'A' ? 'baseline' : 'candidate')
                }
            }
        }
    }
    const summaries = {}
    const median = (values) => {
        const sorted = values.toSorted((a, b) => a - b)
        return (sorted[(sorted.length - 1) >> 1] + sorted[sorted.length >> 1]) / 2
    }
    for (const comparison of plan.comparisons) {
        summaries[comparison] = {}
        for (const corpus of Object.keys(corpora)) {
            const deltas = []
            let baselineCpuMs = 0
            let candidateCpuMs = 0
            for (let pair = 0; pair < plan.pairsPerCorpusPerComparison; ++pair) {
                const a = observations.find((row) => row.comparison === comparison && row.corpus === corpus && row.pair === pair && row.arm === 'A')
                const b = observations.find((row) => row.comparison === comparison && row.corpus === corpus && row.pair === pair && row.arm === 'B')
                assert(a && b)
                baselineCpuMs += a.threadCpuMs
                candidateCpuMs += b.threadCpuMs
                deltas.push({threadCpuPercent: 100 * (b.threadCpuMs / a.threadCpuMs - 1), wallPercent: 100 * (b.elapsedMs / a.elapsedMs - 1)})
            }
            summaries[comparison][corpus] = {medianPairedCpuPercent: median(deltas.map((row) => row.threadCpuPercent)), equalWorkCpuPercent: 100 * (candidateCpuMs / baselineCpuMs - 1), medianPairedWallPercent: median(deltas.map((row) => row.wallPercent)), fasterCpuPairs: deltas.filter((row) => row.threadCpuPercent < 0).length, deltas}
        }
    }
    const result = {status: 'success', plan, inputs, observations, summaries, loadAfter: os.loadavg()}
    writeFileSync(outputPath, JSON.stringify(result, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify({outputPath, summaries}, null, 2))
} catch (error) {
    writeFileSync(outputPath, JSON.stringify({status: 'failed', plan, inputs, observations, error: String(error)}, null, 2) + '\n', {flag: 'wx'})
    throw error
}
