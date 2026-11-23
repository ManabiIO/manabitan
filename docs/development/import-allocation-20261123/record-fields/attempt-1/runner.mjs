import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'

const [candidateRoot, baselineRoot, cache, output, ...requested] = process.argv.slice(2)
const dictionaries = requested.length ? requested : ['jmdict', 'jitendex', 'vndb']
const require = createRequire(path.join(candidateRoot, 'package.json'))
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await import(pathToFileURL(require.resolve('@zip.js/zip.js')))
const candidate = await import(pathToFileURL(path.join(candidateRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
const baseline = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-record-opfs-store.js')))
const parser = await import(pathToFileURL(path.join(candidateRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const filename = 'ext/js/dictionary/term-record-opfs-store.js'
const baselineSource = await fs.readFile(path.join(baselineRoot, filename))
const candidateSource = await fs.readFile(path.join(candidateRoot, filename))
const lockBytes = await fs.readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json'))
const locks = JSON.parse(lockBytes).dictionaries
assert.equal(digest(await fs.readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'))), digest(lockBytes))
const parserSourceFile = 'ext/js/dictionary/term-bank-wasm-parser.js'
const parserSource = await fs.readFile(path.join(candidateRoot, parserSourceFile))
assert.equal(digest(await fs.readFile(path.join(baselineRoot, parserSourceFile))), digest(parserSource))
const wasm = await fs.readFile(path.join(candidateRoot, 'ext/lib/term-bank-parser.wasm'))
assert.equal(digest(await fs.readFile(path.join(baselineRoot, 'ext/lib/term-bank-parser.wasm'))), digest(wasm))
parser.setTermBankWasmModule(await WebAssembly.compile(wasm))
const provenance = {
    candidateCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: candidateRoot, encoding: 'utf8'}).trim(),
    baselineCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: baselineRoot, encoding: 'utf8'}).trim(),
    candidateSourceSha256: digest(candidateSource), baselineSourceSha256: digest(baselineSource),
    runnerSha256: digest(await fs.readFile(new URL(import.meta.url))), lockSha256: digest(lockBytes), wasmSha256: digest(wasm), parserSourceSha256: digest(parserSource), node: process.version,
    scope: 'Full-corpus production-parser record columns, factory-created resolved references, and production record-field encoders. Raw offsets are parser content offsets shifted by 2^40; compressed-reference offsets are synthetic consecutive 16-byte references. This is an exact encoder byte/allocation replay, not browser storage, whole-import timing, or persisted-media validation.',
}
await fs.mkdir(output, {recursive: true})

function instrument(encode) {
    const stats = {allocatedColumnBytes: 0, allocatedColumnBuffers: 0, copiedColumnBytes: 0, copiedColumns: 0}
    const original = []
    for (const name of ['Uint32Array', 'Uint16Array']) {
        const Ctor = globalThis[name]
        const set = Ctor.prototype.set
        original.push({name, Ctor, set})
        globalThis[name] = new Proxy(Ctor, {construct(target, args, newTarget) {
            const result = Reflect.construct(target, args, newTarget)
            if (typeof args[0] === 'number') {
                stats.allocatedColumnBytes += result.byteLength
                stats.allocatedColumnBuffers++
            }
            return result
        }})
        Ctor.prototype.set = function (source, offset) {
            stats.copiedColumnBytes += source.length * Ctor.BYTES_PER_ELEMENT
            stats.copiedColumns++
            return set.call(this, source, offset)
        }
    }
    try { return {bytes: encode(), stats} } finally {
        for (const {name, Ctor, set} of original) {
            globalThis[name] = Ctor
            Ctor.prototype.set = set
        }
    }
}

function sum(into, values) {
    for (const [key, value] of Object.entries(values)) into[key] = (into[key] ?? 0) + value
}

const summaries = []
for (const dictionary of dictionaries) {
    const spec = locks[dictionary]
    const archive = await fs.readFile(path.join(cache, spec.cacheFile))
    assert.equal(digest(archive), spec.sha256)
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive.buffer, archive.byteOffset, archive.byteLength)))
    const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
        .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
    const filesPerGroup = {jmdict: 5, jitendex: 10, vndb: 3}[dictionary]
    const dir = path.join(output, dictionary)
    await fs.mkdir(dir, {recursive: true})
    const totals = {rows: 0, banks: entries.length, groups: 0, sourceJsonBytes: 0}
    const modes = Object.fromEntries(['raw', 'compressed-references'].map((mode) => [mode, {
        baseline: {}, candidate: {}, eligibleRows: 0, compactRows: 0, legacyRows: 0,
        encodedBytes: 0, hash: createHash('sha256'),
    }]))
    const prepared = []
    const stores = {baseline: new baseline.TermRecordOpfsStore(), candidate: new candidate.TermRecordOpfsStore()}
    try {
        for (let start = 0; start < entries.length; start += filesPerGroup) {
            const banks = []
            for (const entry of entries.slice(start, start + filesPerGroup)) {
                const bytes = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
                totals.sourceJsonBytes += bytes.byteLength
                banks.push(bytes)
            }
            let record
            await parser.parseTermBankWithWasmColumnChunks(banks, 3, (chunk) => {
                const plan = chunk.contentDedupPlan
                assert.ok(plan?.uniqueRowIndexes instanceof Uint32Array)
                assert.ok(chunk.contentUniqueIndexList instanceof Uint32Array)
                assert.ok(chunk.contentMetaList instanceof Uint32Array)
                assert.ok(chunk.scoreList instanceof Int32Array)
                const uniqueRows = plan.uniqueRowIndexes
                const uniqueIndexList = new Uint32Array(chunk.contentUniqueIndexList)
                const offsets = new Float64Array(uniqueRows.length)
                const lengths = new Uint32Array(uniqueRows.length)
                for (let unique = 0; unique < uniqueRows.length; unique++) {
                    const row = chunk.contentMetaByUniqueIndex ? unique : uniqueRows[unique] - (chunk.contentRowStart ?? 0)
                    const at = row * 4
                    offsets[unique] = 2 ** 40 + chunk.contentMetaList[at]
                    lengths[unique] = chunk.contentMetaList[at + 1]
                }
                record = {rowCount: chunk.rowCount, scoreList: new Int32Array(chunk.scoreList), uniqueIndexList, offsets, lengths}
            }, 2048, {
                singleChunk: true, emitTermByteLists: false, computeContentHashes: true,
                emitContentSlab: true, emitTokenBinaryContent: true, mediaHintFastScan: true,
                validateGlossaryTypes: true, prepareLookupIndexes: false,
            })
            assert.ok(record)
            const {rowCount, scoreList, uniqueIndexList, offsets, lengths} = record
            for (const [mode, state] of Object.entries(modes)) {
                const modeOffsets = mode === 'raw' ? offsets : Float64Array.from(offsets, (_, i) => 2 ** 40 + i * 16)
                const modeLengths = mode === 'raw' ? lengths : new Uint32Array(lengths.length).fill(16)
                const aChunk = baseline.createArtifactTermRecordChunkWithResolvedContent({rowCount, scoreList}, uniqueIndexList, modeOffsets, modeLengths)
                const bChunk = candidate.createArtifactTermRecordChunkWithResolvedContent({rowCount, scoreList}, uniqueIndexList, modeOffsets, modeLengths)
                const a = instrument(() => stores.baseline._encodeArtifactRecordFields(aChunk, [], [], 2 ** 40))
                const b = instrument(() => stores.candidate._encodeArtifactRecordFields(bChunk, [], [], 2 ** 40))
                assert.equal(Buffer.compare(a.bytes, b.bytes), 0, `${dictionary} group ${start} ${mode}`)
                assert.equal(a.stats.allocatedColumnBytes - b.stats.allocatedColumnBytes, rowCount * 6)
                const compact = b.bytes.byteLength < rowCount * 12
                assert.equal(a.stats.copiedColumnBytes - b.stats.copiedColumnBytes, compact ? rowCount * 6 : 0)
                state.eligibleRows += rowCount
                state[compact ? 'compactRows' : 'legacyRows'] += rowCount
                state.encodedBytes += b.bytes.byteLength
                state.hash.update(b.bytes)
                sum(state.baseline, a.stats)
                sum(state.candidate, b.stats)
            }
            const files = {}
            for (const [column, values] of Object.entries({scoreList, uniqueIndexList, offsets, lengths})) {
                const name = `group-${totals.groups}-${column}.bin`
                const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength)
                await fs.writeFile(path.join(dir, name), bytes)
                files[column] = {path: name, sha256: digest(bytes)}
            }
            prepared.push({rowCount, files})
            totals.rows += rowCount
            totals.groups++
            if (totals.groups % 25 === 0) console.log(`${dictionary}: ${totals.rows} rows verified`)
        }
    } finally { await reader.close() }
    assert.equal(totals.rows, spec.termRows)
    for (const state of Object.values(modes)) state.sha256 = state.hash.digest('hex'), delete state.hash
    const summary = {...provenance, dictionary, archiveSha256: spec.sha256, filesPerGroup, ...totals, modes}
    await fs.writeFile(path.join(dir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
    await fs.writeFile(path.join(dir, 'prepared.json'), `${JSON.stringify({summary, groups: prepared}, null, 2)}\n`)
    summaries.push(summary)
    console.log(JSON.stringify(summary))
}
assert.equal(digest(await fs.readFile(path.join(candidateRoot, filename))), provenance.candidateSourceSha256)
assert.equal(digest(await fs.readFile(path.join(baselineRoot, filename))), provenance.baselineSourceSha256)
assert.equal(digest(await fs.readFile(path.join(candidateRoot, parserSourceFile))), provenance.parserSourceSha256)
await fs.writeFile(path.join(output, 'summary.json'), `${JSON.stringify(summaries, null, 2)}\n`)
