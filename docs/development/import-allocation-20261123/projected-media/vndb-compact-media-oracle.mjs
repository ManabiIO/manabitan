import {readFile, writeFile} from 'node:fs/promises'
import {createHash} from 'node:crypto'
import assert from 'node:assert/strict'
import {inflateRawSync, crc32} from 'node:zlib'
import {serialize} from 'node:v8'
import {pathToFileURL} from 'node:url'
import {execFileSync} from 'node:child_process'
import path from 'node:path'

const root = '/workspace/scratch/1d04fee2c265'
const baselineRoot = path.join(root, 'manabitan')
const candidateRoot = path.join(root, 'manabitan-vndb')
const cacheRoot = '/workspace/scratch/72c24f1e7bc9/manabitan/builds/e2e-dictionary-cache'
const outputPath = path.join(root, 'vndb-compact-media-oracle.json')
const {ZipReader, Uint8ArrayReader} = await import(pathToFileURL(path.join(baselineRoot, 'node_modules/@zip.js/zip.js/index.js')))
const {tryCollectGlossaryImagePaths} = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/dictionary-image-references.js')))
const baseline = await import(pathToFileURL(path.join(baselineRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const candidate = await import(pathToFileURL(path.join(candidateRoot, 'ext/js/dictionary/term-bank-wasm-parser.js')))
const lock = JSON.parse(await readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const runtimeFiles = ['ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-wasm-parser-worker.js', 'ext/js/dictionary/dictionary-importer.js', 'dev/data/dictionary-wasm/term-bank-parser.wasm']
const sources = []
for (const sourceRoot of [baselineRoot, candidateRoot]) {
    sources.push({root: sourceRoot, sha: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: sourceRoot, encoding: 'utf8'}).trim(),
        hashes: Object.fromEntries(await Promise.all(runtimeFiles.map(async file => [file, sha256(await readFile(path.join(sourceRoot, file)))])))})
}
assert.equal(sources[0].hashes[runtimeFiles.at(-1)], sources[1].hashes[runtimeFiles.at(-1)], 'Native parser is unchanged')
candidate.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(candidateRoot, runtimeFiles.at(-1)))))

const options = {singleChunk: true, emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true,
    emitTokenBinaryContent: true, compactContentMetadata: true, mediaHintFastScan: true, validateGlossaryTypes: true, prepareLookupIndexes: true}
const diagnosticFields = ['expression', 'reading', 'expressionBytes', 'readingBytes']
const decoder = new TextDecoder('utf-8', {ignoreBOM: true})
const report = {schema: 1, node: process.version, complete: false, sources,
    scope: 'Complete pinned ZIPs with independent Node inflate and CRC checks. One native parse per fixed four-bank group, followed by both parent and candidate owned result copying. Every non-media column, content buffer, key plan, and prepared lookup index is compared byte-for-byte. Every changed projected path and diagnostic key is checked against independently decoded source JSON; full fallback rows are compared unchanged. Candidate results cross structuredClone with their owned buffers transferred, and diagnostic snapshots remain stable after native heap reuse. Node V8 serialization sizes are mechanical work counts, not browser bytes or peak-memory measurements. No timing inference.', dictionaries: []}

function transferables(value, buffers = new Set(), seen = new Set()) {
    if (value === null || typeof value !== 'object' || seen.has(value)) return buffers
    seen.add(value)
    if (ArrayBuffer.isView(value)) {
        if (value.buffer instanceof ArrayBuffer && value.buffer.byteLength > 0) buffers.add(value.buffer)
    } else if (value instanceof Map) {
        for (const [key, item] of value) { transferables(key, buffers, seen); transferables(item, buffers, seen) }
    } else {
        for (const item of Object.values(value)) transferables(item, buffers, seen)
    }
    return buffers
}

function normalizeMedia(rows) {
    return rows.map(({index, imagePaths, row}) => ({index, imagePaths, row: imagePaths === undefined ? row : Object.fromEntries(diagnosticFields.map(key => [key, row[key]]))}))
}

function keyText(row, key) {
    const value = row[key]
    const bytes = row[`${key}Bytes`]
    return value.length > 0 || !(bytes instanceof Uint8Array) ? value : decoder.decode(bytes)
}

let previousMedia = null
let previousSnapshot = null
try {
    for (const dictionary of ['jmdict', 'jitendex', 'vndb']) {
        const spec = lock[dictionary]
        const archive = await readFile(path.join(cacheRoot, spec.cacheFile))
        assert.equal(archive.length, spec.sizeBytes)
        assert.equal(sha256(archive), spec.sha256)
        const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)), {useWebWorkers: false})
        const entries = (await reader.getEntries()).filter(entry => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const result = {dictionary, archiveSha256: spec.sha256, banks: entries.length, groups: 0, rows: 0, sourceBytes: 0,
            mediaRows: 0, projectedRows: 0, fallbackRows: 0, parentProperties: 0, candidateProperties: 0,
            parentMediaSerializationBytes: 0, candidateMediaSerializationBytes: 0, sourceImagePathCount: 0, uniqueReferencedPaths: 0}
        report.dictionaries.push(result)
        const digest = createHash('sha256')
        const referencedPaths = new Set()
        for (let first = 0; first < entries.length; first += 4) {
            const compressed = []
            const expectedRows = []
            for (const entry of entries.slice(first, first + 4)) {
                const start = entry.offset
                assert.equal(archive.readUInt32LE(start), 0x04034b50)
                assert.equal(archive.readUInt16LE(start + 8), entry.compressionMethod)
                const filenameLength = archive.readUInt16LE(start + 26)
                const extraLength = archive.readUInt16LE(start + 28)
                assert.equal(archive.subarray(start + 30, start + 30 + filenameLength).toString(), entry.filename)
                const payloadStart = start + 30 + filenameLength + extraLength
                const bytes = archive.subarray(payloadStart, payloadStart + entry.compressedSize)
                const decoded = entry.compressionMethod === 0 ? bytes : inflateRawSync(bytes)
                assert.equal(decoded.length, entry.uncompressedSize)
                assert.equal(crc32(decoded), entry.signature)
                expectedRows.push(...JSON.parse(decoded.toString()))
                result.sourceBytes += decoded.length
                compressed.push({bytes, compressionMethod: entry.compressionMethod, compressedSize: bytes.length,
                    uncompressedSize: decoded.length, signature: entry.signature, filename: entry.filename})
            }
            const parserOptions = {...options, experimentalNativeEscapedKeys: dictionary === 'vndb'}
            const preloadedSource = await candidate.inflateCompressedTermBankSourcesWasm(compressed, parserOptions, true)
            await candidate.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, chunk => {
                if (previousMedia !== null) assert.deepEqual(previousMedia, previousSnapshot, 'Media survives native heap reuse')
                assert.equal(chunk.rowCount, expectedRows.length)
                const parent = baseline.copyWasmBackedColumnChunk(chunk, false, true)
                const current = candidate.copyWasmBackedColumnChunk(chunk, false, true)
                const {mediaRows: parentMedia, ...parentColumns} = parent
                const {mediaRows: currentMedia, ...currentColumns} = current
                assert.deepEqual(currentColumns, parentColumns, `${dictionary}:${first}:all unchanged columns`)
                assert.deepEqual(normalizeMedia(currentMedia), normalizeMedia(parentMedia), `${dictionary}:${first}:media semantics`)
                result.parentMediaSerializationBytes += serialize(parentMedia).byteLength
                result.candidateMediaSerializationBytes += serialize(currentMedia).byteLength
                const cloned = structuredClone(current, {transfer: [...transferables(current)]})
                assert.deepEqual(normalizeMedia(cloned.mediaRows), normalizeMedia(parentMedia), `${dictionary}:${first}:transferred media semantics`)
                for (let i = 0; i < cloned.mediaRows.length; ++i) {
                    const {index, row, imagePaths} = cloned.mediaRows[i]
                    const expected = expectedRows[index]
                    const expectedPaths = tryCollectGlossaryImagePaths(JSON.stringify(expected[5]))
                    assert.deepEqual(imagePaths, expectedPaths.length > 0 ? expectedPaths : undefined)
                    assert.equal(keyText(row, 'expression'), expected[0])
                    assert.equal(keyText(row, 'reading') || keyText(row, 'expression'), expected[1] || expected[0])
                    result.parentProperties += Object.keys(parentMedia[i].row).length
                    result.candidateProperties += Object.keys(row).length
                    if (imagePaths !== undefined) {
                        assert.deepEqual(Object.keys(row).sort(), diagnosticFields.toSorted())
                        ++result.projectedRows
                        for (const key of ['expressionBytes', 'readingBytes']) {
                            if (parentMedia[i].row[key]?.buffer === parent.termRecordPreinternedPlan.stringsBuffer.buffer) {
                                assert.equal(row[key]?.buffer, cloned.termRecordPreinternedPlan.stringsBuffer.buffer)
                            }
                        }
                        for (const imagePath of imagePaths) referencedPaths.add(imagePath)
                        result.sourceImagePathCount += imagePaths.length
                    } else {
                        ++result.fallbackRows
                        assert.deepEqual(row, parentMedia[i].row)
                    }
                    digest.update(JSON.stringify([result.rows + index, keyText(row, 'expression'), keyText(row, 'reading'), imagePaths]) + '\n')
                }
                previousMedia = cloned.mediaRows
                previousSnapshot = structuredClone(previousMedia)
                result.mediaRows += cloned.mediaRows.length
                result.rows += chunk.rowCount
                ++result.groups
            }, 2048, {...parserOptions, preloadedSource})
            if (first % 80 === 0 || first + 4 >= entries.length) {
                await writeFile(outputPath, JSON.stringify(report, null, 2))
                console.log(`${dictionary} ${Math.min(first + 4, entries.length)}/${entries.length}: ${result.rows} rows, ${result.projectedRows} projected rows verified`)
            }
        }
        assert.equal(result.rows, spec.termRows)
        result.uniqueReferencedPaths = referencedPaths.size
        assert.equal(result.uniqueReferencedPaths, spec.mediaFiles)
        result.mediaDiagnosticDigest = digest.digest('hex')
        await reader.close()
    }
    assert.deepEqual(previousMedia, previousSnapshot)
    for (const source of sources) {
        for (const [file, expected] of Object.entries(source.hashes)) assert.equal(sha256(await readFile(path.join(source.root, file))), expected, `Source mutated: ${source.root}:${file}`)
    }
    report.complete = true
} catch (error) {
    report.error = error.stack ?? String(error)
    throw error
} finally {
    await writeFile(outputPath, JSON.stringify(report, null, 2))
}
