import assert from 'node:assert/strict'
import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'
import os from 'node:os'

const root = '/workspace/scratch/fbc366eaf75c/manabitan-jmdict'
const work = '/workspace/scratch/fbc366eaf75c/jmdict-screen'
const corpus = JSON.parse(await readFile(`${work}/corpus.json`, 'utf8'))
const entries = await Promise.all(corpus.banks.map(async (item) => ({...item, bytes: new Uint8Array(await readFile(`${work}/banks/${item.name}`))})))
const groups = []
for (let i = 0; i < 12; ++i) {
    groups.push(entries.slice(Math.floor(i * entries.length / 12), Math.floor((i + 1) * entries.length / 12)).map((item) => item.bytes))
}
const options = {
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    singleChunk: true,
    prepareLookupIndexes: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
}
const arms = new Map()
for (const name of ['A', 'B']) {
    const moduleBytes = await readFile(name === 'A' ? `${work}/baseline.wasm` : `${root}/dev/data/dictionary-wasm/term-bank-parser.wasm`)
    const module = await WebAssembly.compile(moduleBytes)
    const parser = await import(`${pathToFileURL(`${root}/ext/js/dictionary/term-bank-wasm-parser.js`)}?copy-utf8-arm=${name}`)
    parser.setTermBankWasmModule(module)
    arms.set(name, {parser, sha256: createHash('sha256').update(moduleBytes).digest('hex')})
}

async function run(name, checksum = false) {
    const {parser} = arms.get(name)
    const hash = checksum ? createHash('sha256') : null
    let rowCount = 0
    let nativeMs = 0
    let fallbackCount = 0
    let fallbackNativeKeyCount = 0
    let maxWasmHeapBytes = 0
    const started = performance.now()
    for (const sources of groups) {
        await parser.parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
            rowCount += chunk.rowCount
            if (hash !== null) {
                const plan = chunk.termRecordPreinternedPlan
                for (const column of [plan.stringLengths, plan.stringOffsets, plan.stringHashes, plan.stringsBuffer, plan.expressionIndexes, plan.readingIndexes, chunk.readingEqualsExpressionList, chunk.scoreList, chunk.sequenceList, chunk.contentMetaList, chunk.contentUniqueIndexList]) {
                    if (column !== null && column !== undefined) hash.update(new Uint8Array(column.buffer, column.byteOffset, column.byteLength))
                }
                const meta = chunk.contentMetaList
                const uniqueIndexes = chunk.contentUniqueIndexList
                for (let row = 0; row < chunk.rowCount; ++row) {
                    const index = chunk.contentMetaByUniqueIndex ? uniqueIndexes[row] : row
                    const start = (chunk.contentBytesBaseOffset ?? 0) + meta[index * 4]
                    hash.update(chunk.contentBytesBuffer.subarray(start, start + meta[index * 4 + 1]))
                }
                for (const [id, index] of chunk.preparedLookupIndexes ?? []) {
                    hash.update(id)
                    hash.update(index.bytes)
                }
            }
        }, 2048, options)
        const profile = parser.consumeLastTermBankWasmParseProfile()
        nativeMs += profile.parseBankMs
        fallbackCount += profile.fusedParseFallbacks ?? 0
        fallbackNativeKeyCount += profile.nativeStringPlanFallbackChunkCount ?? 0
        maxWasmHeapBytes = Math.max(maxWasmHeapBytes, profile.maxWasmHeapBytes ?? 0)
    }
    assert.equal(rowCount, corpus.rows)
    return {name, elapsedMs: performance.now() - started, nativeMs, rowCount, fallbackCount, fallbackNativeKeyCount, maxWasmHeapBytes, sha256: hash?.digest('hex') ?? null}
}

const parity = [await run('A', true), await run('B', true)]
assert.equal(parity[0].sha256, parity[1].sha256)
console.log(JSON.stringify({parity}))
if (process.argv.includes('--parity-only')) process.exit(0)
const warmups = []
for (let i = 0; i < 2; ++i) {
    warmups.push(await run('A'))
    warmups.push(await run('B'))
}
const pairs = []
for (let i = 0; i < 12; ++i) {
    const order = i % 2 === 0 ? ['A', 'B'] : ['B', 'A']
    const results = []
    for (const name of order) results.push(await run(name))
    const baseline = results.find(({name}) => name === 'A')
    const candidate = results.find(({name}) => name === 'B')
    const pair = {index: i, order, baseline, candidate, ratio: candidate.elapsedMs / baseline.elapsedMs}
    pairs.push(pair)
    console.log(JSON.stringify(pair))
}
const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b)
    const middle = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
const report = {
    kind: 'node-parser-component-screen',
    completedAt: new Date().toISOString(),
    runtime: process.version,
    cpu: os.cpus()[0]?.model,
    source: '0143e9596cd8f790d5e166d4ba6a2425fbc57f14',
    modules: Object.fromEntries([...arms].map(([name, arm]) => [name, arm.sha256])),
    corpus,
    groups: groups.map((group) => group.map((source) => source.byteLength)),
    options,
    parity,
    warmups,
    pairs,
    medians: {baselineMs: median(pairs.map(({baseline}) => baseline.elapsedMs)), candidateMs: median(pairs.map(({candidate}) => candidate.elapsedMs)), pairedRatio: median(pairs.map(({ratio}) => ratio))},
}
await writeFile(`${work}/parser-screen.json`, JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report.medians))
