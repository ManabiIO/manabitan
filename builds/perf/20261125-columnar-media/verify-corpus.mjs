import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {serialize} from 'node:v8'

const [baselineRoot, candidateRoot, cacheRoot, outputPath] = process.argv.slice(2)
assert(baselineRoot && candidateRoot && cacheRoot && outputPath,
    'Usage: node --expose-gc verify-corpus.mjs BASELINE_ROOT CANDIDATE_ROOT FIXTURE_CACHE OUTPUT_JSON')
const roots = [baselineRoot, candidateRoot].map((root) => path.resolve(root))
const {BlobReader, Uint8ArrayWriter, ZipReader} = await import(pathToFileURL(path.join(candidateRoot, 'node_modules/@zip.js/zip.js/index.js')))
const lockBytes = await readFile(path.join(baselineRoot, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(lockBytes, await readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json')))
const lock = JSON.parse(lockBytes)
const skippedTimingKeys = new Set(['preparedLookupIndexEncodeMs'])
const options = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    experimentalNativeEscapedKeys: true,
    compactContentMetadata: true,
}
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
async function hashFile(file) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(file)) { hash.update(bytes) }
    return hash.digest('hex')
}
const runtimePaths = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/lib/term-bank-parser.wasm',
]
const modules = []
const sources = []
for (const [arm, root] of roots.entries()) {
    const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
    const preparation = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-lookup-index-preparation.js')))
    const {DictionaryImporter} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/dictionary-importer.js')))
    const {DictionaryImporterMediaLoader} = await import(pathToFileURL(path.join(root, 'test/mocks/dictionary-importer-media-loader.js')))
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))))
    modules.push({parser, preparation, importer: new DictionaryImporter(new DictionaryImporterMediaLoader())})
    const paths = arm === 0 ? runtimePaths : [...runtimePaths, 'ext/js/dictionary/dictionary-media-diagnostics.js']
    const hashes = {}
    for (const file of paths) { hashes[file] = await hashFile(path.join(root, file)) }
    sources.push({root, head: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(), hashes})
}
assert.equal(sources[0].hashes['ext/lib/term-bank-parser.wasm'], sources[1].hashes['ext/lib/term-bank-parser.wasm'])
function hashValue(hash, value) {
    if (ArrayBuffer.isView(value)) {
        hash.update(JSON.stringify(['view', value.constructor.name, value.byteLength]) + '\n')
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof Map) {
        hash.update(JSON.stringify(['map', value.size]) + '\n')
        for (const [key, item] of value) { hashValue(hash, key); hashValue(hash, item) }
    } else if (Array.isArray(value)) {
        hash.update(JSON.stringify(['array', value.length]) + '\n')
        for (const item of value) { hashValue(hash, item) }
    } else if (value !== null && typeof value === 'object') {
        const keys = Object.keys(value).filter((key) => !skippedTimingKeys.has(key)).sort()
        hash.update(JSON.stringify(['object', keys]) + '\n')
        for (const key of keys) { hashValue(hash, value[key]) }
    } else {
        assert.notEqual(typeof value, 'function')
        hash.update(JSON.stringify([typeof value, value]) + '\n')
    }
}
function countMediaObjects(value) {
    const seen = new Set()
    const counts = {objects: 0, arrays: 0, views: 0, maps: 0}
    function visit(item) {
        if (item === null || typeof item !== 'object' || seen.has(item)) { return }
        seen.add(item)
        if (ArrayBuffer.isView(item)) { ++counts.views; return }
        if (Array.isArray(item)) { ++counts.arrays; for (const child of item) { visit(child) }; return }
        if (item instanceof Map) { ++counts.maps; for (const [key, child] of item) { visit(key); visit(child) }; return }
        ++counts.objects
        for (const child of Object.values(item)) { visit(child) }
    }
    visit(value)
    return counts
}
function normalizeMedia(chunk, importer) {
    if (chunk.projectedMedia) { return {mediaRows: chunk.mediaRows, projectedMedia: chunk.projectedMedia} }
    const rowIndexes = []
    const pathEnds = []
    const paths = []
    const mediaRows = []
    for (const row of chunk.mediaRows) {
        if (typeof row.imagePaths === 'undefined') { mediaRows.push(row); continue }
        rowIndexes.push(row.index)
        paths.push(...row.imagePaths)
        pathEnds.push(paths.length)
    }
    const projectedMedia = rowIndexes.length === 0 ? undefined : {
        rowIndexes: Uint32Array.from(rowIndexes), pathEnds: Uint32Array.from(pathEnds), paths,
        diagnosticKeys: importer._createMediaReferenceDiagnostics(chunk),
    }
    return {mediaRows, projectedMedia}
}
const report = {
    scope: 'Complete fixed-four-bank parser-copy/media-transport parity; not a browser import or latency benchmark',
    node: process.version,
    runnerSha256: await hashFile(new URL(import.meta.url)),
    lockSha256: sha256(lockBytes), sources, options, filesPerGroup: 4,
    skippedTimingKeys: [...skippedTimingKeys],
    serializationScope: 'Sum of Node v8.serialize media payload lengths before transfer; not Chrome wire size or peak memory',
    corpora: [], complete: false,
}
await writeFile(outputPath, JSON.stringify(report, null, 2))
for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
    const spec = lock.dictionaries[dictionary]
    const archivePath = path.join(cacheRoot, spec.cacheFile)
    assert.equal(await hashFile(archivePath), spec.sha256)
    const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), {useWebWorkers: false})
    const banks = []
    const archivePaths = new Set()
    try {
        for await (const entry of reader.getEntriesGenerator()) {
            archivePaths.add(entry.filename)
            if (/^term_bank_\d+\.json$/.test(entry.filename)) { banks.push(entry) }
        }
        banks.sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const corpus = {dictionary, archiveSha256: spec.sha256, banks: banks.length, rows: 0,
            groups: [], projectedRows: 0, projectedPaths: 0, uniqueProjectedPaths: 0,
            fallbackMediaRows: 0, mediaSerializedBytes: [0, 0],
            mediaObjects: [{objects: 0, arrays: 0, views: 0, maps: 0}, {objects: 0, arrays: 0, views: 0, maps: 0}],
            digest: null, complete: false}
        report.corpora.push(corpus)
        const corpusHash = createHash('sha256')
        const allImagePaths = new Set()
        for (let start = 0; start < banks.length; start += 4) {
            const selected = banks.slice(start, start + 4)
            const bytes = []
            for (const bank of selected) { bytes.push(await bank.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})) }
            const results = []
            for (const [arm, {parser, preparation, importer}] of modules.entries()) {
                const hash = createHash('sha256')
                let rows = 0
                let mediaStats = null
                await parser.parseTermBankWithWasmColumnChunks(bytes, 3, (chunk) => {
                    if (!chunk.preparedLookupIndexes) {
                        const prepared = preparation.prepareTermLookupIndexesFromPreinternedPlan(chunk)
                        assert(prepared)
                        chunk.preparedLookupIndexes = prepared.indexes
                    }
                    assert(preparation.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount))
                    const stable = parser.copyWasmBackedColumnChunk(chunk, true, true, true, arm === 1)
                    const {mediaRows, projectedMedia, ...columns} = stable
                    const mediaPayload = typeof projectedMedia === 'undefined' ? {mediaRows} : {mediaRows, projectedMedia}
                    const serializedBytes = serialize(mediaPayload).byteLength
                    const objects = countMediaObjects(mediaPayload)
                    corpus.mediaSerializedBytes[arm] += serializedBytes
                    for (const key of Object.keys(objects)) { corpus.mediaObjects[arm][key] += objects[key] }
                    const normalized = normalizeMedia(stable, importer)
                    hashValue(hash, columns)
                    hashValue(hash, normalized)
                    rows += stable.rowCount
                    mediaStats = {projectedRows: normalized.projectedMedia?.rowIndexes.length ?? 0,
                        projectedPaths: normalized.projectedMedia?.paths.length ?? 0,
                        fallbackRows: normalized.mediaRows.length}
                    if (arm === 1) {
                        for (const imagePath of normalized.projectedMedia?.paths ?? []) {
                            assert(archivePaths.has(imagePath), `Missing archive image ${imagePath}`)
                            allImagePaths.add(imagePath)
                        }
                    }
                }, 2048, options)
                const profile = parser.consumeLastTermBankWasmParseProfile()
                assert(profile)
                assert.equal(profile.rowCount, rows)
                results.push({rows, digest: hash.digest('hex'), mediaStats})
            }
            assert.deepEqual(results[0], results[1], `${dictionary} group ${start / 4}`)
            corpus.rows += results[0].rows
            corpus.projectedRows += results[0].mediaStats?.projectedRows ?? 0
            corpus.projectedPaths += results[0].mediaStats?.projectedPaths ?? 0
            corpus.fallbackMediaRows += results[0].mediaStats?.fallbackRows ?? 0
            corpusHash.update(results[0].digest)
            corpus.groups.push({start: selected[0].filename, end: selected.at(-1).filename, ...results[0]})
            if (corpus.groups.length % 16 === 0) {
                console.log(`${dictionary}: ${corpus.rows} rows / ${corpus.groups.length} groups match`)
                await writeFile(outputPath, JSON.stringify(report, null, 2))
                globalThis.gc?.()
            }
        }
        assert.equal(corpus.rows, spec.termRows)
        corpus.uniqueProjectedPaths = allImagePaths.size
        corpus.digest = corpusHash.digest('hex')
        corpus.complete = true
        await writeFile(outputPath, JSON.stringify(report, null, 2))
        console.log(`${dictionary}: ${corpus.rows} rows; ${corpus.projectedRows} projected media rows; complete parity`)
    } finally { await reader.close() }
}
for (const {root, hashes} of sources) {
    for (const [file, expected] of Object.entries(hashes)) { assert.equal(await hashFile(path.join(root, file)), expected, `Source changed: ${root}/${file}`) }
}
report.complete = true
await writeFile(outputPath, JSON.stringify(report, null, 2))
console.log(outputPath)
