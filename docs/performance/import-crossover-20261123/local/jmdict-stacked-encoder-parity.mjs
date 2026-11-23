import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import {openAsBlob, createReadStream} from 'node:fs'
import {createHash} from 'node:crypto'
import {ZipReader, BlobReader, Uint8ArrayWriter} from './manabitan/node_modules/@zip.js/zip.js/index.js'
import * as baseline from './jmdict-direct-base/ext/js/dictionary/term-record-opfs-store.js'
import * as candidate from './jmdict-stacked/ext/js/dictionary/term-record-opfs-store.js'
import * as parser from './jmdict-stacked/ext/js/dictionary/term-bank-wasm-parser.js'

const task = '/workspace/scratch/0a1757ac2970'
const cache = '/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache'
const lockBytes = await fs.readFile(`${task}/jmdict-stacked/test/perf/dictionaries.lock.json`)
const lock = JSON.parse(lockBytes).dictionaries
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const wasm = await fs.readFile(`${task}/jmdict-stacked/ext/lib/term-bank-parser.wasm`)
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
const baseStore = new baseline.TermRecordOpfsStore()
const candidateStore = new candidate.TermRecordOpfsStore()
const types = [baseline, candidate]
const stores = [baseStore, candidateStore]
const sourceFile = 'ext/js/dictionary/term-record-opfs-store.js'
const sourceHashes = await Promise.all(['jmdict-direct-base', 'jmdict-stacked'].map(async arm => sha256(await fs.readFile(`${task}/${arm}/${sourceFile}`))))
const output = {baselineCommit: '10a8f09e96ff943ec1351b1391cb56fa7e20feed', sourceArms: ['jmdict-direct-base', 'jmdict-stacked'], scope: 'Byte-for-byte artifact record-field equivalence for every locked source-bank row. Deterministic resolved offsets above 1 TiB, with constant compact lengths and actual native token lengths. No timing measurement or full-import/persisted-database equivalence claim.', node: process.version, v8: process.versions.v8, lockSha256: sha256(lockBytes), parserWasmSha256: sha256(wasm), sourceFile, sourceHashes, results: []}
for (const corpus of process.argv.slice(2).length ? process.argv.slice(2) : ['jmdict','jitendex','vndb']) {
    const spec = lock[corpus]
    const archive = await openAsBlob(`${cache}/${spec.cacheFile}`)
    assert.equal(archive.size, spec.sizeBytes)
    const archiveHash = createHash('sha256')
    for await (const chunk of createReadStream(`${cache}/${spec.cacheFile}`)) archiveHash.update(chunk)
    assert.equal(archiveHash.digest('hex'), spec.sha256)
    const reader = new ZipReader(new BlobReader(archive))
    const entries = []
    for await (const entry of reader.getEntriesGenerator()) if (/^term_bank_\d+\.json$/.test(entry.filename)) entries.push(entry)
    entries.sort((a,b) => Number(a.filename.slice(10,-5))-Number(b.filename.slice(10,-5)))
    let rows = 0, runs = 0, contentRuns = 0, scoreRuns = 0, bytes = 0, variableBytes = 0
    const digest = createHash('sha256')
    const variableDigest = createHash('sha256')
    for (const entry of entries) {
        const source = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
        await parser.parseTermBankWithWasmColumnChunks(source, 3, chunk => {
            const count = chunk.rowCount
            const indexes = new Uint32Array(chunk.contentUniqueIndexList)
            const uniqueCount = chunk.contentDedupPlan.resolvedFlags.length
            const offsets = Float64Array.from({length: uniqueCount}, (_,i) => 2 ** 40 + i * 20)
            const lengths = new Uint32Array(uniqueCount).fill(20)
            const scores = new Int32Array(chunk.scoreList)
            const payload = {rowCount: count, scoreList: scores}
            const pair = types.map(type => type.createArtifactTermRecordChunkWithResolvedContent(payload, indexes, offsets, lengths))
            const a = stores[0]._encodeArtifactRecordFields(pair[0], [], [], 2 ** 40)
            const b = stores[1]._encodeArtifactRecordFields(pair[1], [], [], 2 ** 40)
            assert.deepEqual(b, a)
            digest.update(a)
            bytes += a.length
            const rawLengths = new Uint32Array(uniqueCount)
            for (let row = 0; row < count; ++row) {
                const meta = (chunk.contentMetaByUniqueIndex ? indexes[row] : row) * 4
                rawLengths[indexes[row]] = chunk.contentMetaList[meta + 1]
            }
            const variable = types.map(type => type.createArtifactTermRecordChunkWithResolvedContent(payload, indexes, offsets, rawLengths))
            const variableA = stores[0]._encodeArtifactRecordFields(variable[0], [], [], 2 ** 40)
            const variableB = stores[1]._encodeArtifactRecordFields(variable[1], [], [], 2 ** 40)
            assert.deepEqual(variableB, variableA)
            variableDigest.update(variableA)
            variableBytes += variableA.length
            for (let row = 0; row < count; ++row) {
                if (row === 0 || indexes[row] !== indexes[row - 1] || scores[row] !== scores[row - 1]) ++runs
                if (row === 0 || indexes[row] !== indexes[row - 1]) ++contentRuns
                if (row === 0 || scores[row] !== scores[row - 1]) ++scoreRuns
            }
            rows += count
        }, 30000, {singleChunk: true, emitTermByteLists: false, emitContentSlab: true, emitTokenBinaryContent: true, computeContentHashes: true, mediaHintFastScan: true, validateGlossaryTypes: true})
    }
    await reader.close()
    assert.equal(rows, spec.termRows)
    const result = {corpus, archiveSha256: spec.sha256, banks: entries.length, rows, contentScoreRuns: runs, contentRuns, scoreRuns, repeatedRows: rows-runs, fieldBytes: bytes, fieldDigest: digest.digest('hex'), variableFieldBytes: variableBytes, variableFieldDigest: variableDigest.digest('hex'), memory: process.memoryUsage()}
    output.results.push(result)
    console.log(JSON.stringify(result))
    await fs.writeFile(`${task}/jmdict-stacked-encoder-parity-results.json`, JSON.stringify(output,null,2)+'\n')
}
