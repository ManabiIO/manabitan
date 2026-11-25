import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, open, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {serialize} from 'node:v8'

// Bounded, untimed source comparison. Run each dictionary in a fresh process.
// node replay.mjs DICTIONARY BASE_ROOT CANDIDATE_ROOT CACHE_DIRECTORY
const [dictionary, baseRoot, candidateRoot, cacheRoot, childStart, childArm] = process.argv.slice(2)
const isChild = typeof childStart !== 'undefined'
assert.ok(['jmdict', 'jitendex', 'vndb'].includes(dictionary))
assert.ok(baseRoot && candidateRoot && cacheRoot)
const outRoot = path.dirname(fileURLToPath(import.meta.url))
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const load = (root, name) => import(pathToFileURL(path.join(root, name)).href)
const gitHead = (root) => execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim()
const lockBytes = await readFile(path.join(baseRoot, 'test/perf/dictionaries.lock.json'))
assert.deepEqual(await readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json')), lockBytes)
const spec = JSON.parse(lockBytes).dictionaries[dictionary]
const archivePath = path.join(cacheRoot, spec.cacheFile)
if (!isChild) {
    const archiveHash = createHash('sha256')
    for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
    assert.equal(archiveHash.digest('hex'), spec.sha256)
}

// Python reads the ZIP directory and exits before parser instances are created.
// The Node process reads only each bounded group's compressed source payloads.
const entriesPath = path.join(outRoot, `${dictionary}-zip-entries.json`)
const entries = isChild ? JSON.parse(await readFile(entriesPath, 'utf8')) : JSON.parse(execFileSync('python3', ['-c', `
import json, re, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as z:
    entries = [dict(filename=e.filename, headerOffset=e.header_offset,
                    compressionMethod=e.compress_type, compressedSize=e.compress_size,
                    uncompressedSize=e.file_size, signature=e.CRC)
               for e in z.infolist() if re.fullmatch(r'term_bank_\\d+\\.json', e.filename)]
    entries.sort(key=lambda e: int(e['filename'][10:-5]))
    print(json.dumps(entries))
`, archivePath], {encoding: 'utf8', maxBuffer: 2 * 1024 * 1024}))
assert.ok(entries.length > 0)
const totalSourceBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
const projectImagePaths = spec.mediaFiles > 0
const explicitFlags = {experimentalNativeEscapedKeys: projectImagePaths && totalSourceBytes >= 512 * 1024 * 1024}
const options = {
    ...explicitFlags,
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    compactContentMetadata: true,
    mediaHintFastScan: projectImagePaths,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
    prepareLookupRoute: true,
    projectImagePaths,
}
const filesPerGroup = 2
const sourceFiles = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-bank-wasm-parser-worker.js',
    'ext/js/dictionary/dictionary-importer.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'dev/data/dictionary-wasm/manifest.json',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
]
async function createArm(root, instantiate = true) {
    const parser = await load(root, 'ext/js/dictionary/term-bank-wasm-parser.js')
    const preparation = await load(root, 'ext/js/dictionary/term-lookup-index-preparation.js')
    const {buildTermLookupFilter} = await load(root, 'ext/js/dictionary/term-lookup-route.js')
    const {snapshotTermBankExperiments} = await load(root, 'ext/js/dictionary/term-bank-experiments.js')
    const wasmBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
    assert.deepEqual(wasmBytes, await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm')))
    if (instantiate) { parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes)) }
    const sourceHashes = {}
    for (const file of sourceFiles) { sourceHashes[file] = sha256(await readFile(path.join(root, file))) }
    return {root, parser, preparation, buildTermLookupFilter, identity: {root, head: gitHead(root), sourceHashes, wasmSha256: sha256(wasmBytes), flags: snapshotTermBankExperiments(explicitFlags)}}
}
const base = isChild ? null : await createArm(baseRoot, false)
const candidate = isChild ? null : await createArm(candidateRoot, false)
if (!isChild) { assert.deepEqual(base.identity.flags, candidate.identity.flags) }

async function readExactly(handle, size, position) {
    const bytes = new Uint8Array(size)
    let filled = 0
    while (filled < size) {
        const {bytesRead} = await handle.read(bytes, filled, size - filled, position + filled)
        assert.ok(bytesRead > 0, 'Unexpected end of ZIP archive')
        filled += bytesRead
    }
    return bytes
}
async function readSource(handle, entry) {
    const header = await readExactly(handle, 30, entry.headerOffset)
    const fields = new DataView(header.buffer)
    assert.equal(fields.getUint32(0, true), 0x04034b50)
    assert.equal(fields.getUint16(8, true), entry.compressionMethod)
    assert.equal(fields.getUint16(6, true) & 1, 0)
    const nameLength = fields.getUint16(26, true)
    const extraLength = fields.getUint16(28, true)
    const name = await readExactly(handle, nameLength, entry.headerOffset + 30)
    assert.equal(new TextDecoder().decode(name), entry.filename)
    const bytes = await readExactly(handle, entry.compressedSize, entry.headerOffset + 30 + nameLength + extraLength)
    return {...entry, bytes}
}

function copyWithCounters(arm, chunk, source) {
    const counters = {jsonParseCalls: 0, jsonParseUtf8Bytes: 0, textDecodeCalls: 0, textDecodeBytes: 0, nativeProjectionCalls: 0, nativeProjectedSpans: 0}
    const jsonParse = JSON.parse
    const decode = TextDecoder.prototype.decode
    const nativeProject = source.wasm.project_single_glossary_image_path
    JSON.parse = function (value, ...args) {
        counters.jsonParseCalls++
        counters.jsonParseUtf8Bytes += Buffer.byteLength(value)
        return jsonParse.call(this, value, ...args)
    }
    TextDecoder.prototype.decode = function (value, ...args) {
        counters.textDecodeCalls++
        counters.textDecodeBytes += value?.byteLength ?? 0
        return decode.call(this, value, ...args)
    }
    if (typeof nativeProject === 'function') {
        source.wasm.project_single_glossary_image_path = (...args) => {
            counters.nativeProjectionCalls++
            const result = nativeProject(...args)
            counters.nativeProjectedSpans += result === 0n ? 0 : 1
            return result
        }
    }
    try {
        return {chunk: arm.parser.copyWasmBackedColumnChunk(chunk, false, projectImagePaths, true, source), counters}
    } finally {
        JSON.parse = jsonParse
        TextDecoder.prototype.decode = decode
        if (typeof nativeProject === 'function') { source.wasm.project_single_glossary_image_path = nativeProject }
    }
}

async function parse(arm, sources) {
    const source = await arm.parser.inflateCompressedTermBankSourcesWasm(sources, explicitFlags, true)
    let result
    await arm.parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
        assert.equal(result, undefined)
        result = copyWithCounters(arm, chunk, source)
    }, 2048, {...options, preloadedSource: source})
    assert.ok(result)
    const chunk = result.chunk
    if (!(chunk.preparedLookupIndexes instanceof Map)) {
        const prepared = arm.preparation.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, explicitFlags)
        assert.ok(prepared)
        chunk.preparedLookupIndexes = prepared.indexes
    }
    for (const prepared of chunk.preparedLookupIndexes.values()) {
        prepared.routeFilter ??= arm.buildTermLookupFilter(prepared.preinternedPlan.stringHashes)
    }
    // This is the only runtime metric on the compared chunk, not stored data.
    delete chunk.preparedLookupIndexEncodeMs
    result.mediaV8SerializedBytes = serialize(chunk.mediaRows).byteLength
    result.profile = arm.parser.consumeLastTermBankWasmParseProfile()
    return result
}

function canonicalHash(value, hash = createHash('sha256')) {
    if (value === undefined || value === null || typeof value !== 'object') {
        const scalar = typeof value === 'string' ? JSON.stringify(value) : Object.is(value, -0) ? '-0' : String(value)
        hash.update(`${typeof value}:${scalar};`)
    } else if (ArrayBuffer.isView(value)) {
        hash.update(`${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else if (value instanceof ArrayBuffer || value instanceof SharedArrayBuffer) {
        hash.update(`${value.constructor.name}:${value.byteLength}:`)
        hash.update(new Uint8Array(value))
    } else if (value instanceof Map) {
        hash.update(`Map:${value.size}:`)
        for (const [key, item] of value) { canonicalHash(key, hash); canonicalHash(item, hash) }
    } else if (Array.isArray(value)) {
        hash.update(`Array:${value.length}:`)
        for (const item of value) { canonicalHash(item, hash) }
    } else {
        const keys = Object.keys(value).sort()
        hash.update(`Object:${keys.length}:`)
        for (const key of keys) { canonicalHash(key, hash); canonicalHash(value[key], hash) }
    }
    return hash
}

async function replayGroup(root, start) {
    const arm = await createArm(root)
    const archive = await open(archivePath, 'r')
    try {
        const sources = []
        for (const entry of entries.slice(start, start + filesPerGroup)) { sources.push(await readSource(archive, entry)) }
        const result = await parse(arm, sources)
        const normalized = {...result.chunk, mediaRows: result.chunk.mediaRows.map((entry) => {
            if (typeof entry.imagePaths === 'undefined') { return entry }
            const {expression, reading, expressionBytes, readingBytes} = entry.row
            return {...entry, row: {expression, reading, expressionBytes, readingBytes}}
        })}
        const fieldHashes = {}
        for (const key of Object.keys(normalized).sort()) { fieldHashes[key] = canonicalHash(normalized[key]).digest('hex') }
        return {
            rows: result.chunk.rowCount,
            mediaRows: result.chunk.mediaRows.length,
            projectedRows: result.chunk.mediaRows.filter(({imagePaths}) => typeof imagePaths !== 'undefined').length,
            fallbackRows: result.chunk.mediaRows.filter(({imagePaths}) => typeof imagePaths === 'undefined').length,
            mediaV8SerializedBytes: result.mediaV8SerializedBytes,
            copy: result.counters,
            fieldHashes,
            outputSha256: canonicalHash(normalized).digest('hex'),
            parserHeapBytes: result.profile?.maxWasmHeapBytes,
        }
    } finally { await archive.close() }
}

if (isChild) {
    assert.ok(['baseline', 'candidate'].includes(childArm))
    console.log(JSON.stringify(await replayGroup(childArm === 'baseline' ? baseRoot : candidateRoot, Number(childStart))))
    process.exit(0)
}

const report = {
    dictionary,
    scope: 'Complete locked term corpus. Sequential fresh children with one WASM instance and at most two banks each. Raw compressed ZIP source, CRC verification, parser, copied columns, canonical content/dedup metadata, completed lookup indexes/routes and media diagnostic/path equality. Each output field and full normalized output is hashed over every value and typed byte; baseline projected media rows normalize to the four consumed diagnostic fields, fallback rows remain complete. Only the lookup encode duration is omitted. No whole-import time, peak browser memory, persisted OPFS, compression, UI or lookup-latency claim. V8 serialization counts are a Node representation measure, not Chrome wire bytes.',
    provenance: {nativeProjectionPr: 875, nativeProjectionHead: 'fb71a03f4611bcfa71e135693bebd1fe778153bf', compactMediaPr: 850, compactMediaHead: '3597a103b0f35d076587e08196caa9f5d12f53ef'},
    node: process.version,
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    lockSha256: sha256(lockBytes),
    archiveSha256: spec.sha256,
    archiveBytes: spec.sizeBytes,
    expectedRows: spec.termRows,
    banks: entries.length,
    sourceBytes: totalSourceBytes,
    filesPerGroup,
    options,
    baseline: base.identity,
    candidate: candidate.identity,
    groups: [],
    totals: {rows: 0, mediaRows: 0, projectedRows: 0, fallbackRows: 0, baselineMediaV8SerializedBytes: 0, candidateMediaV8SerializedBytes: 0, baselineCopy: {}, candidateCopy: {}},
}
const reportPath = path.join(outRoot, `${dictionary}.json`)
const outputHash = createHash('sha256')
await mkdir(outRoot, {recursive: true})
await writeFile(entriesPath, `${JSON.stringify(entries)}\n`)
try {
    for (let start = 0; start < entries.length; start += filesPerGroup) {
        const groupEntries = entries.slice(start, start + filesPerGroup)
        const outputs = {}
        for (const arm of ['baseline', 'candidate']) {
            try {
                const stdout = execFileSync(process.execPath, [fileURLToPath(import.meta.url), dictionary, baseRoot, candidateRoot, cacheRoot, `${start}`, arm], {
                    encoding: 'utf8',
                    maxBuffer: 2 * 1024 * 1024,
                    env: {...process.env, NODE_OPTIONS: '--max-old-space-size=768'},
                    stdio: ['ignore', 'pipe', 'pipe'],
                })
                outputs[arm] = JSON.parse(stdout)
            } catch (error) {
                report.failure = {group: report.groups.length, start, arm, message: error.message, status: error.status, signal: error.signal, stdout: error.stdout?.toString(), stderr: error.stderr?.toString()}
                throw error
            }
        }
        const a = outputs.baseline
        const b = outputs.candidate
        assert.deepStrictEqual(b.fieldHashes, a.fieldHashes)
        assert.equal(b.outputSha256, a.outputSha256)
        for (const key of ['rows', 'mediaRows', 'projectedRows', 'fallbackRows']) { assert.equal(b[key], a[key]) }
        outputHash.update(b.outputSha256)
        const group = {
            group: report.groups.length,
            firstBank: groupEntries[0].filename,
            lastBank: groupEntries.at(-1).filename,
            sourceBytes: groupEntries.reduce((sum, source) => sum + source.uncompressedSize, 0),
            rows: b.rows,
            mediaRows: b.mediaRows,
            projectedRows: b.projectedRows,
            fallbackRows: b.fallbackRows,
            baselineMediaV8SerializedBytes: a.mediaV8SerializedBytes,
            candidateMediaV8SerializedBytes: b.mediaV8SerializedBytes,
            baselineCopy: a.copy,
            candidateCopy: b.copy,
            baselineParserHeapBytes: a.parserHeapBytes,
            candidateParserHeapBytes: b.parserHeapBytes,
            outputSha256: b.outputSha256,
            fieldHashes: b.fieldHashes,
        }
        report.groups.push(group)
        for (const key of ['rows', 'mediaRows', 'projectedRows', 'fallbackRows', 'baselineMediaV8SerializedBytes', 'candidateMediaV8SerializedBytes']) { report.totals[key] += group[key] }
        for (const arm of ['baselineCopy', 'candidateCopy']) {
            for (const [key, count] of Object.entries(group[arm])) { report.totals[arm][key] = (report.totals[arm][key] ?? 0) + count }
        }
        if (report.groups.length % 10 === 0 || start + filesPerGroup >= entries.length) {
            console.log(JSON.stringify({dictionary, completeGroups: report.groups.length, rows: report.totals.rows, mediaRows: report.totals.mediaRows}))
            await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
        }
    }
    assert.equal(report.totals.rows, spec.termRows)
    for (const arm of [base, candidate]) {
        for (const file of sourceFiles) { assert.equal(sha256(await readFile(path.join(arm.root, file))), arm.identity.sourceHashes[file], `Source changed during replay: ${file}`) }
    }
    report.outputSha256 = outputHash.digest('hex')
    report.complete = true
} catch (error) {
    report.complete = false
    report.failure ??= {message: error.message, stack: error.stack}
    throw error
} finally {
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
}
console.log(JSON.stringify({dictionary, ...report.totals, outputSha256: report.outputSha256, complete: true}))
