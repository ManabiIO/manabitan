import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import {crc32, inflateRawSync} from 'node:zlib'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.dirname(new URL(import.meta.url).pathname)
const baselinePath = path.join(root, 'manabitan')
const candidatePath = path.join(root, 'vndb-media-bookkeeping')
const outputPath = path.join(root, 'vndb-bookkeeping-projection-parity.json')
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const git = (cwd, ref) => execFileSync('git', ['rev-parse', ref], {cwd, encoding: 'utf8'}).trim()
const lock = JSON.parse(await readFile(path.join(baselinePath, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.vndb
const archive = await openAsBlob(path.join(baselinePath, 'builds/e2e-dictionary-cache', lock.cacheFile))
const receipt = {
    scope: 'Full locked VNDB source-bank component parity. Real native parser and copyWasmBackedColumnChunk provide owned image projections to the actual importer; only the parser-to-importer transport is wrapped to reproduce worker delivery in Node. All selected typed term columns/content, requirement order and copied diagnostic bytes are compared. The all-unique-deferred replay is a component scenario, not a measured browser branch count; no OPFS, import speed, or peak-memory claim.',
    fixture: lock,
    node: process.version,
    outputPath,
    checkouts: [],
    banks: [],
}
const states = []

for (const [label, checkout] of [['baseline', baselinePath], ['candidate', candidatePath]]) {
    const importerUrl = pathToFileURL(path.join(checkout, 'ext/js/dictionary/dictionary-importer.js'))
    const parserUrl = new URL('./term-bank-wasm-parser.js', importerUrl)
    const parser = await import(parserUrl.href)
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(checkout, 'ext/lib/term-bank-parser.wasm'))))
    const originalSource = await readFile(importerUrl, 'utf8')
    assert.equal(originalSource.split('    parseTermBankWithWasmColumnChunks,\n').length, 2)
    let source = originalSource.replace('    parseTermBankWithWasmColumnChunks,\n', '    parseTermBankWithWasmColumnChunks as nativeParseTermBankWithWasmColumnChunks,\n')
    source = source.replace(/from (['"])([.][.]?\/[^'"\n]+)\1/g, (_match, quote, relative) => `from ${quote}${new URL(relative, importerUrl).href}${quote}`)
    source = source.replaceAll('import.meta.url', JSON.stringify(importerUrl.href))
    source += `\nimport {copyWasmBackedColumnChunk as projectOwnedChunk} from ${JSON.stringify(parserUrl.href)}\n`
    source += `async function parseTermBankWithWasmColumnChunks(source, version, onChunk, size, options) {\n`
    source += `    return await nativeParseTermBankWithWasmColumnChunks(source, version, async (chunk, progress) => {\n`
    source += `        const projected = projectOwnedChunk(chunk, false, true)\n`
    source += `        globalThis.__vndbProjectionStats(${JSON.stringify(label)}, projected)\n`
    source += `        await onChunk(projected, progress)\n`
    source += `    }, size, options)\n}\n`
    const {DictionaryImporter} = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
    const importer = new DictionaryImporter({getImageDetails: async () => { throw new Error('Media decoding is outside this column/diagnostic oracle') }})
    Reflect.set(importer, '_skipImageMetadata', true)
    states.push({label, importer, parser, seenPaths: new Set(), firstDiagnostics: new Map(), rows: 0, projectedRows: 0, requirements: 0, uniqueDeferred: 0, stats: null})
    receipt.checkouts.push({label, checkout, head: git(checkout, 'HEAD'), tree: git(checkout, 'HEAD^{tree}'), originalImporterSha256: hashBytes(originalSource), transportWrapperSha256: hashBytes(source), wasmSha256: hashBytes(await readFile(path.join(checkout, 'ext/lib/term-bank-parser.wasm')))})
}
assert.equal(receipt.checkouts[0].wasmSha256, receipt.checkouts[1].wasmSha256)
globalThis.__vndbProjectionStats = (label, chunk) => {
    const state = states.find((value) => value.label === label)
    for (const row of chunk.mediaRows) {
        if (typeof row.imagePaths !== 'undefined') { state.stats.projectedRows++ }
    }
}
const {readDenseZipDirectory} = await import(pathToFileURL(path.join(baselinePath, 'ext/js/dictionary/dense-zip-directory.js')).href)
const {RawZipPayloadReader} = await import(pathToFileURL(path.join(baselinePath, 'ext/js/dictionary/term-bank-source-pipeline.js')).href)
const entries = await readDenseZipDirectory(archive)
assert(entries)
const banks = entries.filter(({filename}) => /^term_bank_\d+[.]json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const rawReader = new RawZipPayloadReader(archive)
const frame = (hash, name, value) => {
    if (ArrayBuffer.isView(value)) {
        hash.update(JSON.stringify([name, value.constructor.name, value.byteLength]) + '\n')
        hash.update(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
    } else {
        hash.update(JSON.stringify([name, value]) + '\n')
    }
}
const inspectChunk = (state, chunk, requirements) => {
    const {columnsHash, requirementHash, diagnosticHash, deferredHash} = state.stats
    state.stats.rows += chunk.rowCount
    state.stats.chunks++
    for (const name of ['rowCount', 'contentRowStart', 'contentBytesBaseOffset', 'contentBytesLength', 'contentMetaByUniqueIndex', 'useResolvedContentReferences', 'dictionary', 'uniformContentDictName', 'readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentBytesBuffer', 'contentHash1List', 'contentHash2List', 'contentMetaList', 'contentUniqueIndexList']) {
        frame(columnsHash, name, chunk[name])
    }
    for (const name of ['expressionBytesList', 'readingBytesList', 'contentBytesList']) {
        const values = chunk[name]
        frame(columnsHash, `${name}.length`, values.length)
        for (const value of values) { frame(columnsHash, name, value) }
    }
    for (const name of ['stringsBuffer', 'stringLengths', 'stringOffsets', 'stringHashes', 'expressionIndexes', 'readingIndexes']) {
        frame(columnsHash, `plan.${name}`, chunk.termRecordPreinternedPlan[name])
    }
    for (const [name, prepared] of chunk.preparedLookupIndexes ?? []) { frame(columnsHash, `prepared.${name}`, prepared.bytes) }
    const seenArenas = new Set()
    for (const requirement of requirements ?? []) {
        state.stats.requirements++
        const entry = requirement.entry ?? requirement
        const {diagnosticKeys, diagnosticIndex} = entry
        assert(diagnosticKeys, 'Every source media requirement must use projected diagnostics in this replay')
        frame(requirementHash, 'requirement', [requirement.source.path, entry.dictionary, diagnosticIndex])
        if (!seenArenas.has(diagnosticKeys)) {
            seenArenas.add(diagnosticKeys)
            assert(diagnosticKeys.bytes.buffer instanceof ArrayBuffer)
            assert.equal(diagnosticKeys.bytes.byteLength, diagnosticKeys.bytes.buffer.byteLength)
            frame(diagnosticHash, 'bytes', diagnosticKeys.bytes)
            frame(diagnosticHash, 'spans', diagnosticKeys.spans)
            frame(diagnosticHash, 'decoded', [...(diagnosticKeys.decodedKeys ?? [])])
        }
        const path = requirement.source.path
        if (state.seenPaths.has(path)) { continue }
        state.seenPaths.add(path)
        state.stats.uniqueDeferred++
        const deferred = state.importer._createDeferredMediaRequirement(requirement)
        frame(deferredHash, 'deferred', [deferred.source.path, deferred.dictionary, deferred.diagnosticIndex])
        const offset = deferred.diagnosticIndex * 4
        const {bytes, spans} = deferred.diagnosticKeys
        frame(deferredHash, 'expression', bytes.subarray(spans[offset], spans[offset] + spans[offset + 1]))
        frame(deferredHash, 'reading', bytes.subarray(spans[offset + 2], spans[offset + 2] + spans[offset + 3]))
        if (state.firstDiagnostics.size < 3) { state.firstDiagnostics.set(path, deferred) }
    }
}

for (let bankIndex = 0; bankIndex < banks.length; ++bankIndex) {
    const entry = banks[bankIndex]
    const compressed = await rawReader.read(entry, new AbortController().signal)
    const source = entry.compressionMethod === 8 ? inflateRawSync(compressed) : compressed
    assert.equal(source.byteLength, entry.uncompressedSize)
    assert.equal(crc32(source), entry.signature)
    const result = {filename: entry.filename, sourceBytes: source.byteLength, sourceSha256: hashBytes(source), runs: []}
    for (const state of states) {
        state.stats = {rows: 0, chunks: 0, projectedRows: 0, requirements: 0, uniqueDeferred: 0, columnsHash: createHash('sha256'), requirementHash: createHash('sha256'), diagnosticHash: createHash('sha256'), deferredHash: createHash('sha256')}
        await state.importer._readTermBankFileFast(entry, 3, lock.expectedTitle, false, true, true, 'raw-bytes', (chunk, requirements) => inspectChunk(state, chunk, requirements), source)
        const run = {label: state.label}
        for (const [key, value] of Object.entries(state.stats)) { run[key] = key.endsWith('Hash') ? value.digest('hex') : value }
        for (const key of ['rows', 'projectedRows', 'requirements', 'uniqueDeferred']) { state[key] += run[key] }
        result.runs.push(run)
    }
    assert.deepEqual(Object.fromEntries(Object.entries(result.runs[0]).filter(([key]) => key !== 'label')), Object.fromEntries(Object.entries(result.runs[1]).filter(([key]) => key !== 'label')), entry.filename)
    receipt.banks.push(result)
    if ((bankIndex + 1) % 50 === 0 || bankIndex + 1 === banks.length) {
        console.log(JSON.stringify({banksCompleted: bankIndex + 1, totalBanks: banks.length, rows: states[0].rows, projectedRows: states[0].projectedRows, uniqueMediaPaths: states[0].seenPaths.size}))
    }
}
receipt.totals = states.map(({label, rows, projectedRows, requirements, uniqueDeferred}) => ({label, rows, projectedRows, requirements, uniqueDeferred}))
assert.equal(states[0].rows, lock.termRows)
assert.equal(states[0].seenPaths.size, lock.mediaFiles)
receipt.earlyDeferredDiagnosticErrors = []
for (const state of states) {
    const errors = []
    for (const [path, deferred] of state.firstDiagnostics) {
        try {
            await state.importer._importDeferredMediaRequirements([deferred], [], new Map(), async () => { throw new Error('Missing-media replay must not write') })
            assert.fail('Expected missing-media diagnostic')
        } catch (error) {
            assert.match(error.message, /^Could not find image at path /)
            errors.push({path, message: error.message})
        }
    }
    receipt.earlyDeferredDiagnosticErrors.push({label: state.label, errors})
}
assert.deepEqual(receipt.earlyDeferredDiagnosticErrors[0].errors, receipt.earlyDeferredDiagnosticErrors[1].errors)
receipt.structuralObjectLiteralReduction = {
    projectedEntryWrappers: states[0].projectedRows,
    additionalRequirementAndSourceClonesInAllUniqueDeferredReplay: states[0].uniqueDeferred * 2,
    caveat: 'Structural source-level object-literal executions removed for this replay. Browser prefetch/defer selection can change the second count; no allocated-byte or peak-memory conclusion.',
}
receipt.status = 'passed'
await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n')
console.log(JSON.stringify({status: receipt.status, totals: receipt.totals, structuralObjectLiteralReduction: receipt.structuralObjectLiteralReduction, outputPath}))
