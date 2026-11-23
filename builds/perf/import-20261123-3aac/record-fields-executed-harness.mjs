import fs from 'node:fs/promises'
import path from 'node:path'
import v8 from 'node:v8'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import JSZip from '/workspace/scratch/72c24f1e7bc9/manabitan/node_modules/jszip/lib/index.js'
import * as baseline from './manabitan/ext/js/dictionary/term-record-opfs-store.js'
import * as candidate from './vndb-record-fields/ext/js/dictionary/term-record-opfs-store.js'
import {parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from './manabitan/ext/js/dictionary/term-bank-wasm-parser.js'
import {hasCompletePreparedTermLookupIndexes} from './manabitan/ext/js/dictionary/term-lookup-index-preparation.js'

const root = '/workspace/scratch/3aacd533c01f'
const fixtures = '/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache'
const output = path.join(root, 'vndb-field-study')
await fs.mkdir(output, {recursive: true})
const lock = JSON.parse(await fs.readFile(path.join(root, 'manabitan/test/perf/dictionaries.lock.json'), 'utf8'))
const parserSource = await fs.readFile(path.join(root, 'manabitan/ext/js/dictionary/term-bank-wasm-parser.js'), 'utf8')
const partitionSource = parserSource.slice(parserSource.indexOf('function partitionSourceBanks('), parserSource.indexOf('/**\n * @param {ParallelTermBankSourceValue[]}'))
const partition = new Function(`${partitionSource}\nreturn partitionSourceBanks`)()
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const signatures = {
    baseline: sha256(await fs.readFile(path.join(root, 'manabitan/ext/js/dictionary/term-record-opfs-store.js'))),
    candidate: sha256(await fs.readFile(path.join(root, 'vndb-record-fields/ext/js/dictionary/term-record-opfs-store.js'))),
    wasm: sha256(await fs.readFile(path.join(root, 'manabitan/dev/data/dictionary-wasm/term-bank-parser.wasm'))),
    node: process.version,
    v8: process.versions.v8,
}
await setTermBankWasmModule(await WebAssembly.compile(await fs.readFile(path.join(root, 'manabitan/dev/data/dictionary-wasm/term-bank-parser.wasm'))))

async function capture(id) {
    const cached = path.join(output, `${id}.v8`)
    try { return v8.deserialize(await fs.readFile(cached)) } catch (error) { if (error.code !== 'ENOENT') throw error }
    const fixture = lock.dictionaries[id]
    const bytes = await fs.readFile(path.join(fixtures, fixture.cacheFile))
    if (bytes.byteLength !== fixture.sizeBytes || sha256(bytes) !== fixture.sha256) throw new Error(`Fixture mismatch: ${id}`)
    const archive = await JSZip.loadAsync(bytes)
    const banks = Object.values(archive.files).filter((file) => /^term_bank_\d+\.json$/.test(file.name)).sort((a, b) => Number(a.name.slice(10, -5)) - Number(b.name.slice(10, -5)))
    const sources = banks.map((bank) => ({bank, estimatedBytes: bank._data.uncompressedSize}))
    const totalBytes = sources.reduce((total, entry) => total + entry.estimatedBytes, 0)
    const mediaHintFastScan = id !== 'jmdict'
    // Match the production five-worker lazy partition, including its minimum
    // source groups. This component capture does not run browser transport.
    const groups = partition(sources, totalBytes, Math.max(5 * (mediaHintFastScan ? 3 : 4), Math.ceil(totalBytes / (24 * 1024 * 1024))))
    const chunks = []
    let rows = 0
    for (let group = 0; group < groups.length; ++group) {
        const decoded = await Promise.all(groups[group].map(({bank}) => bank.async('uint8array')))
        await parseTermBankWithWasmColumnChunks(decoded, 3, (chunk) => {
            const plan = chunk.contentDedupPlan
            if (!plan || !chunk.contentMetaList || !chunk.contentUniqueIndexList) throw new Error('Missing deduplicated field columns')
            const offsets = new Float64Array(plan.uniqueCount)
            const lengths = new Uint32Array(plan.uniqueCount)
            for (let unique = 0; unique < plan.uniqueCount; ++unique) {
                const row = chunk.contentMetaByUniqueIndex ? unique : plan.uniqueRowIndexes[unique]
                // Preserve actual encoded content lengths and repeated IDs.
                // Offset placement is a component fixture above 4 GiB, not a
                // claim about compression/storage allocation in the browser.
                offsets[unique] = 2 ** 40 + chunk.contentMetaList[row * 4]
                lengths[unique] = chunk.contentMetaList[row * 4 + 1]
            }
            const count = chunk.rowCount
            const whole = chunk.preparedLookupIndexes?.has(`0:${count}`) && hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, count)
            const limit = whole ? count : 30000
            for (let start = 0; start < count; start += limit) {
                const end = Math.min(count, start + limit)
                chunks.push({
                    rowCount: end - start,
                    scoreList: new chunk.scoreList.constructor(chunk.scoreList.subarray(start, end)),
                    uniqueIndexList: new Uint32Array(chunk.contentUniqueIndexList.subarray(start, end)),
                    offsets,
                    lengths,
                    factory: start === 0 && end === count,
                    contentMetaByUniqueIndex: chunk.contentMetaByUniqueIndex === true,
                    banks: groups[group].map(({bank}) => bank.name),
                })
                rows += end - start
            }
        }, 8192, {emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false, singleChunk: true, prepareLookupIndexes: true, mediaHintFastScan, validateGlossaryTypes: true, compactContentMetadata: true})
        if (group % 25 === 0 || group + 1 === groups.length) console.log(JSON.stringify({phase:'capture', id, group:group+1, groups:groups.length, rows}))
    }
    if (rows !== fixture.termRows) throw new Error(`Row mismatch: ${id} ${rows} != ${fixture.termRows}`)
    const capture = {id, fixture, groups: groups.length, banks: banks.length, rows, chunks}
    await fs.writeFile(cached, v8.serialize(capture))
    return capture
}

function createWorkload(module, capture) {
    const store = new module.TermRecordOpfsStore()
    const chunks = capture.chunks.map(({rowCount, scoreList, uniqueIndexList, offsets, lengths, factory, contentMetaByUniqueIndex}) => {
        const value = module.createArtifactTermRecordChunkWithResolvedContent({rowCount, scoreList, ...(contentMetaByUniqueIndex ? {contentMetaByUniqueIndex} : {})}, uniqueIndexList, offsets, lengths)
        return factory ? value : {...value}
    })
    return {store, chunks}
}

function encodeAll(workload) {
    let total = 0
    for (const chunk of workload.chunks) {
        const bytes = workload.store._encodeArtifactRecordFields(chunk, [], [], 2 ** 40)
        total += bytes.byteLength + bytes[bytes.byteLength - 1]
    }
    return total
}

if (process.argv.includes('--capture-only')) {
    for (const id of ['jmdict', 'jitendex', 'vndb']) await capture(id)
    process.exit(0)
}

const reports = []
for (const id of ['jmdict', 'jitendex', 'vndb']) {
    const data = await capture(id)
    const A = createWorkload(baseline, data)
    const B = createWorkload(candidate, data)
    const digest = createHash('sha256')
    let outputBytes = 0
    for (let i = 0; i < data.chunks.length; ++i) {
        const a = A.store._encodeArtifactRecordFields(A.chunks[i], [], [], 2 ** 40)
        const b = B.store._encodeArtifactRecordFields(B.chunks[i], [], [], 2 ** 40)
        if (!Buffer.from(a).equals(Buffer.from(b))) throw new Error(`Byte mismatch ${id} chunk ${i}`)
        digest.update(b)
        outputBytes += b.byteLength
    }
    let repeatedRowsAvoided = 0
    let eligibleRows = 0
    let eligibleChunks = 0
    for (const chunk of data.chunks) {
        if (!chunk.factory || !chunk.contentMetaByUniqueIndex || chunk.rowCount < 64 || chunk.offsets.length >= chunk.rowCount || !(chunk.scoreList instanceof Int32Array)) continue
        ++eligibleChunks
        eligibleRows += chunk.rowCount
        for (let i = 1; i < chunk.rowCount; ++i) {
            if (chunk.uniqueIndexList[i] === chunk.uniqueIndexList[i - 1] && chunk.scoreList[i] === chunk.scoreList[i - 1]) ++repeatedRowsAvoided
        }
    }
    encodeAll(A)
    encodeAll(B)
    encodeAll(B)
    encodeAll(A)
    const timing = []
    for (let pair = 0; pair < 4; ++pair) {
        const entry = {pair: pair + 1, order: pair % 2 === 0 ? 'AB' : 'BA'}
        for (const arm of entry.order) {
            const start = performance.now()
            let checksum = 0
            for (let repeat = 0; repeat < 4; ++repeat) checksum += encodeAll(arm === 'A' ? A : B)
            entry[arm] = {checksum, ms: performance.now() - start, fullCorpusPasses: 4}
        }
        entry.changePct = (entry.B.ms / entry.A.ms - 1) * 100
        timing.push(entry)
        console.log(JSON.stringify({phase:'timing',id,...entry}))
    }
    const report = {id, fixture: data.fixture, sourceGroups:data.groups, banks:data.banks, rows:data.rows, fieldChunks:data.chunks.length, eligibleChunks, eligibleRows, repeatedRowsAvoided, outputBytes, sha256:digest.digest('hex'), timing, signatures}
    reports.push(report)
    await fs.writeFile(path.join(output, `${id}-report.json`), `${JSON.stringify(report,null,2)}\n`)
}
// Actual work counting is deliberately after every timing observation so a
// temporary typed-array prototype spy cannot perturb measured optimized code.
for (const report of reports) {
    const workload = createWorkload(candidate, v8.deserialize(await fs.readFile(path.join(output, `${report.id}.v8`))))
    let bulkFillRuns = 0
    let bulkFillRows = 0
    const originalFill = Uint32Array.prototype.fill
    Uint32Array.prototype.fill = function (value, start, end) {
        ++bulkFillRuns
        bulkFillRows += (end ?? this.length) - (start ?? 0)
        return originalFill.call(this, value, start, end)
    }
    try { encodeAll(workload) } finally { Uint32Array.prototype.fill = originalFill }
    Object.assign(report, {bulkFillRuns, bulkFillRows, measuredRepeatedRowsAvoided: bulkFillRows - bulkFillRuns})
    await fs.writeFile(path.join(output, `${report.id}-report.json`), `${JSON.stringify(report,null,2)}\n`)
}
await fs.writeFile(path.join(output, 'report.json'), `${JSON.stringify({signatures,reports},null,2)}\n`)
if (sha256(await fs.readFile(path.join(root, 'manabitan/ext/js/dictionary/term-record-opfs-store.js'))) !== signatures.baseline || sha256(await fs.readFile(path.join(root, 'vndb-record-fields/ext/js/dictionary/term-record-opfs-store.js'))) !== signatures.candidate) throw new Error('Source changed during field screen')
await fs.copyFile(path.join(root, 'manabitan/ext/js/dictionary/term-record-opfs-store.js'), path.join(output, 'baseline.js'))
await fs.copyFile(path.join(root, 'vndb-record-fields/ext/js/dictionary/term-record-opfs-store.js'), path.join(output, 'candidate.js'))
await fs.copyFile(new URL(import.meta.url), path.join(output, 'harness.mjs'))
