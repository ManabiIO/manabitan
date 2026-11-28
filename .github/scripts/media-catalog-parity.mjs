import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'

const args = process.argv.slice(2)
const option = (name) => args[args.indexOf(name) + 1]
const json = (value) => JSON.stringify(value, null, 2) + '\n'
const sha256 = (value) => createHash('sha256').update(value).digest('hex')
const sourceFiles = [
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dense-zip-file-map.js',
    'ext/js/dictionary/dense-zip-filenames.js',
    'ext/js/dictionary/source-zip-media-pack.js',
    'ext/js/dictionary/source-zip-media-preparation-worker.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/wasm/term-bank-inflate.c',
    'ext/lib/term-bank-parser.wasm',
]
async function identity(root) {
    const files = {}
    for (const name of sourceFiles) {
        try { files[name] = sha256(await readFile(path.join(root, name))) }
        catch (error) { if (error.code !== 'ENOENT') { throw error } }
    }
    return {head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), files}
}
async function hashFile(filename) {
    const hash = createHash('sha256')
    for await (const bytes of createReadStream(filename)) { hash.update(bytes) }
    return hash.digest('hex')
}
async function hashBlob(blob) {
    const hash = createHash('sha256')
    for await (const bytes of blob.stream()) { hash.update(bytes) }
    return hash.digest('hex')
}
function memory(label) {
    assert.equal(typeof globalThis.gc, 'function')
    globalThis.gc()
    globalThis.gc()
    const usage = process.memoryUsage()
    return {label, ...usage, heapAndArrayBuffersBytes: usage.heapUsed + usage.arrayBuffers}
}
function entryDigest(entries, compact) {
    const hash = createHash('sha256')
    for (let start = 0; start < entries.length; start += 1024) {
        const end = Math.min(start + 1024, entries.length)
        const batch = compact ? entries.getEntries(start, end) : entries.slice(start, end)
        for (const entry of batch) {
            hash.update(json([entry.filename, entry.offset, entry.compressedSize, entry.uncompressedSize, entry.compressionMethod, entry.signature, entry.encrypted, entry.directory]))
            hash.update(entry.rawFilename)
        }
    }
    return hash.digest('hex')
}
async function child(config) {
    const {root, archivePath, compact, phase} = config
    const identityBefore = await identity(root)
    const moduleAt = (name) => import(pathToFileURL(path.join(root, 'ext/js', name)).href)
    const [directory, {preparePackedSourceZipMediaIndex}, {RawZipPayloadReader}, {setTermBankWasmModule}, {getImageMediaTypeFromFileName}] = await Promise.all([
        moduleAt('dictionary/dense-zip-directory.js'), moduleAt('dictionary/source-zip-media-pack.js'),
        moduleAt('dictionary/term-bank-source-pipeline.js'), moduleAt('dictionary/term-bank-wasm-parser.js'),
        moduleAt('media/media-util.js'),
    ])
    const nativeBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
    setTermBankWasmModule(await WebAssembly.compile(nativeBytes))
    const archive = await openAsBlob(archivePath)
    const memorySamples = phase === 'memory' ? [memory('beforeCatalog')] : []
    const started = performance.now()
    const entries = await (compact ? directory.readDenseZipEntryCatalog : directory.readDenseZipDirectory)(archive)
    assert.ok(entries)
    const allCount = entries.length
    const allEntriesSha256 = phase === 'qualification' ? entryDigest(entries, compact) : null
    let selected
    if (compact) {
        entries.selectFilenames((filename) => getImageMediaTypeFromFileName(filename) !== null)
        selected = entries
    } else {
        selected = entries.filter(({filename}) => getImageMediaTypeFromFileName(filename) !== null)
    }
    const selectedCount = selected.length
    const selectedEntriesSha256 = phase === 'qualification' ? entryDigest(selected, compact) : null
    if (phase === 'memory') { memorySamples.push(memory('catalogReady')) }
    let materializedEntries = 0
    let maxMaterializedBatch = 0
    if (compact) {
        const getEntries = selected.getEntries.bind(selected)
        selected.getEntries = (start, end) => {
            materializedEntries += end - start
            maxMaterializedBatch = Math.max(maxMaterializedBatch, end - start)
            assert.ok(end - start <= 1024)
            return getEntries(start, end)
        }
    }
    let batchCount = 0
    let independentCrcChecks = 0
    let independentDecodedBytes = 0
    const payloadHash = createHash('sha256')
    const reader = new RawZipPayloadReader(archive)
    const readBatch = reader.readBatch.bind(reader)
    reader.readBatch = async (...args) => {
        ++batchCount
        if (phase === 'memory' && batchCount === 1) { memorySamples.push(memory('beforeFirstRead')) }
        const result = await readBatch(...args)
        assert.ok(result)
        if (phase === 'qualification') {
            for (const source of result.sources) {
                const decoded = source.compressionMethod === 8 ? inflateRawSync(source.bytes) : source.bytes
                assert.equal(decoded.byteLength, source.uncompressedSize)
                assert.equal(crc32(decoded), source.signature)
                ++independentCrcChecks
                independentDecodedBytes += decoded.byteLength
                payloadHash.update(json([source.filename, source.archiveOffset, source.compressedSize, source.uncompressedSize, source.compressionMethod, source.signature]))
                payloadHash.update(decoded)
            }
        }
        if (phase === 'memory' && [1, 72, 144].includes(batchCount)) { memorySamples.push(memory(`afterRead${batchCount}`)) }
        return result
    }
    const packed = await preparePackedSourceZipMediaIndex(archive, selected, reader, () => {})
    assert.ok(packed)
    const stageMs = performance.now() - started
    if (phase === 'memory') { memorySamples.push(memory('afterPack')) }
    const output = {
        descriptor: packed.plan.descriptor,
        indexSha256: sha256(packed.plan.index),
        sourceSpanSha256: await hashBlob(packed.blob),
        rangeReadCount: packed.rangeReadCount,
        rangeReadBytes: packed.rangeReadBytes,
        compressedBytes: packed.compressedBytes,
        uncompressedBytes: packed.uncompressedBytes,
    }
    if (compact) {
        assert.equal(materializedEntries, selectedCount)
        assert.equal(maxMaterializedBatch, 1024)
    }
    if (phase === 'qualification') { assert.equal(independentCrcChecks, selectedCount) }
    const identityAfter = await identity(root)
    assert.deepEqual(identityAfter, identityBefore)
    return {
        complete: true, config, processId: process.pid, node: process.version,
        identity: identityBefore, allCount, selectedCount, batchCount,
        materializedEntries, maxMaterializedBatch, allEntriesSha256, selectedEntriesSha256,
        independentCrcChecks, independentDecodedBytes,
        independentPayloadSha256: phase === 'qualification' ? payloadHash.digest('hex') : null,
        output, memorySamples, stageMs,
        timingScope: 'Diagnostic only: forced GC in memory phase, independent zlib validation in qualification phase; neither supports latency claims.',
    }
}
if (process.argv[2] === '--child') {
    const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
    const result = await child(config)
    await writeFile(config.report, json(result))
} else {
    const archivePath = path.resolve(option('--archive'))
    const baseline = path.resolve(option('--baseline'))
    const candidate = path.resolve(option('--candidate'))
    const destination = path.resolve(option('--out'))
    await mkdir(destination, {recursive: true})
    const protocol = {
        registeredAt: new Date().toISOString(),
        archivePath, archiveSha256: await hashFile(archivePath),
        baseline: await identity(baseline), candidate: await identity(candidate),
        harnessSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
        phaseOrder: ['qualification-A', 'qualification-B', 'memory-A', 'memory-B', 'memory-C'],
        scope: 'Complete media parity and Node retained-memory diagnostic, not a browser timing claim. A/C use the same baseline. Fresh Node process per observation. Synchronous full GC at predefined memory checkpoints. Peak RSS is not measured.',
    }
    const fixture = JSON.parse(await readFile(path.join(candidate, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.vndb
    assert.equal(protocol.archiveSha256, fixture.sha256)
    await writeFile(path.join(destination, 'protocol.json'), json(protocol))
    const results = []
    for (const observation of protocol.phaseOrder) {
        const [phase, arm] = observation.split('-')
        const compact = arm === 'B'
        const report = path.join(destination, `${observation}.json`)
        const configPath = path.join(destination, `${observation}-config.json`)
        const config = {phase, arm, compact, root: compact ? candidate : baseline, archivePath, report}
        await writeFile(configPath, json(config))
        execFileSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), '--child', configPath], {stdio: 'inherit'})
        const result = JSON.parse(await readFile(report, 'utf8'))
        assert.equal(result.complete, true)
        if (results.length > 0) { assert.deepEqual(result.output, results[0].output) }
        results.push(result)
        await writeFile(path.join(destination, 'results.partial.json'), json({complete: false, protocol, results}))
        console.log(json({observation, allCount: result.allCount, selectedCount: result.selectedCount, memorySamples: result.memorySamples}))
    }
    for (const name of ['allEntriesSha256', 'selectedEntriesSha256', 'independentPayloadSha256', 'independentCrcChecks', 'independentDecodedBytes']) {
        assert.deepEqual(results[1][name], results[0][name])
    }
    assert.equal(await hashFile(archivePath), protocol.archiveSha256)
    await writeFile(path.join(destination, 'results.json'), json({complete: true, protocol, results}))
}
