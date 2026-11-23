import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {cpus, loadavg} from 'node:os'
import {resolve} from 'node:path'
import {performance} from 'node:perf_hooks'
import {pathToFileURL} from 'node:url'

const [baselineRoot, candidateRoot, fixturePath, outputPath] = process.argv.slice(2).map(x => resolve(x))
const modulePath = 'ext/js/dictionary/dictionary-generation-media-store.js'
const moduleUrl = root => pathToFileURL(resolve(root, modulePath)).href
const arms = {
    A: await import(moduleUrl(baselineRoot) + '?control=A'),
    B: await import(moduleUrl(candidateRoot) + '?candidate=B'),
    C: await import(moduleUrl(baselineRoot) + '?control=C'),
}
const {readDenseZipDirectory} = await import(pathToFileURL(resolve(baselineRoot, 'ext/js/dictionary/dense-zip-directory.js')))
const {preparePackedSourceZipMedia} = await import(pathToFileURL(resolve(baselineRoot, 'ext/js/dictionary/source-zip-media-pack.js')))
const {RawZipPayloadReader} = await import(pathToFileURL(resolve(baselineRoot, 'ext/js/dictionary/term-bank-source-pipeline.js')))
const {setTermBankWasmModule} = await import(pathToFileURL(resolve(baselineRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const {getImageMediaTypeFromFileName} = await import(pathToFileURL(resolve(baselineRoot, 'ext/js/media/media-util.js')))

const lock = JSON.parse(await readFile(resolve(baselineRoot, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.vndb
const hash = createHash('sha256')
for await (const bytes of createReadStream(fixturePath)) { hash.update(bytes) }
const archiveHash = hash.digest('hex')
assert.equal(archiveHash, lock.sha256)
const archive = await openAsBlob(fixturePath)
assert.equal(archive.size, lock.sizeBytes)
const entries = await readDenseZipDirectory(archive)
assert(entries)
const images = entries.filter(x => getImageMediaTypeFromFileName(x.filename) !== null)
assert.equal(images.length, lock.mediaFiles)
const fileMap = new Map(entries.map(x => [x.filename, x]))
const requirements = images.map(x => ({type: 'image', source: {path: x.filename}}))
const wasmBytes = await readFile(resolve(baselineRoot, 'ext/lib/term-bank-parser.wasm'))
setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
const prepared = await preparePackedSourceZipMedia(archive, requirements, fileMap, new RawZipPayloadReader(archive), () => {})
assert(prepared)
const {records, blob} = prepared
assert.equal(records.length, lock.mediaFiles)
const dataBytes = blob.size
const paths = records.map(x => x.path)
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const references = {}
for (const [label, api] of Object.entries(arms)) {
    references[label] = api.createGenerationMediaIndex(records, dataBytes)
    assert(references[label])
    assert.deepEqual(references[label], references.A)
}
const modes = {all: paths, withoutFirst256: paths.slice(256)}
const permutations = ['ABC', 'BCA', 'CAB', 'ACB', 'CBA', 'BAC']
const rows = []
const hostBefore = loadavg()
for (const [mode, selectedPaths] of Object.entries(modes)) {
    const expected = arms.A.restrictGenerationMediaIndex(references.A, selectedPaths)
    assert(expected)
    for (const api of Object.values(arms)) {
        assert.deepEqual(api.restrictGenerationMediaIndex(references.A, selectedPaths), expected)
    }
    for (let block = -2; block < 12; ++block) {
        const order = permutations[(block + permutations.length) % permutations.length]
        for (const label of order) {
            const started = performance.now()
            const plan = arms[label].createGenerationMediaIndex(records, dataBytes)
            const created = performance.now()
            const selected = arms[label].restrictGenerationMediaIndex(plan, selectedPaths)
            const ended = performance.now()
            assert.deepEqual(plan, references.A)
            assert.deepEqual(selected, expected)
            rows.push({mode, block, warmup: block < 0, order, arm: label, createMs: created - started, selectMs: ended - created, totalMs: ended - started})
        }
    }
}
const median = xs => {const sorted = xs.toSorted((a,b) => a-b); return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2}
const comparisons = {}
for (const mode of Object.keys(modes)) {
    comparisons[mode] = {}
    for (const [numerator, denominator] of [['B','A'], ['B','C'], ['C','A']]) {
        const paired = []
        let numeratorTotal = 0
        let denominatorTotal = 0
        for (let block = 0; block < 12; ++block) {
            const group = rows.filter(x => x.mode === mode && x.block === block)
            const n = group.find(x => x.arm === numerator).totalMs
            const d = group.find(x => x.arm === denominator).totalMs
            paired.push((n / d - 1) * 100)
            numeratorTotal += n
            denominatorTotal += d
        }
        comparisons[mode][`${numerator}/${denominator}`] = {pairedMedianPercent: median(paired), equalWorkPercent: (numeratorTotal / denominatorTotal - 1) * 100, fasterPairs: paired.filter(x => x < 0).length, pairedPercent: paired}
    }
}
const result = {
    scope: 'Node component only: generation media index creation and selection on all verified VNDB image records. No complete-import, OPFS, browser, peak-memory, or lookup-time claim.',
    corpus: {path: fixturePath, sha256: archiveHash, archiveBytes: archive.size, images: records.length, dataBytes, indexBytes: references.A.index.length, indexSha256: digest(references.A.index), productionPreparationMetrics: {validationMs: prepared.validationMs, readMs: prepared.readMs}},
    inputs: {baselineRoot, candidateRoot, baselineModuleSha256: digest(await readFile(resolve(baselineRoot,modulePath))), candidateModuleSha256: digest(await readFile(resolve(candidateRoot,modulePath))), modulePath},
    environment: {node: process.version, v8: process.versions.v8, platform: process.platform, cpu: cpus()[0]?.model, logicalCpus: cpus().length, loadBefore: hostBefore, loadAfter: loadavg()},
    design: {warmupTripletsPerMode: 2, measuredTripletsPerMode: 12, permutations, sameCodeControl: 'C/A', omittedObservations: 0, subset: 'withoutFirst256 excludes the first 256 source-directory image records to exercise a nearly complete selection; it is not an assertion about production prefetch order.'},
    comparisons,
    rows,
}
await writeFile(outputPath, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({corpus: result.corpus, environment: result.environment, comparisons}, null, 2))
