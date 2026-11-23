/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import path from 'node:path'
import {pathToFileURL, fileURLToPath} from 'node:url'

const [baselineRoot, candidateRoot, cacheRoot, destination] = process.argv.slice(2)
assert(baselineRoot && candidateRoot && cacheRoot && destination, 'Expected baseline, candidate, cache, receipt')
const importAt = async (root, filename) => await import(pathToFileURL(path.join(root, filename)).href)
const {ZipReader, Uint8ArrayReader, Uint8ArrayWriter} = await importAt(candidateRoot, 'node_modules/@zip.js/zip.js/index.js')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const lockBytes = await readFile(path.join(candidateRoot, 'test/perf/dictionaries.lock.json'))
const lock = JSON.parse(lockBytes)
const selected = {jmdict: 7, jitendex: 10, vndb: 3}
const sourcePaths = [
    'ext/js/dictionary/wasm/term-bank-parser.c',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-lookup-index-preparation.js',
    'ext/js/dictionary/term-lookup-index.js',
    'ext/lib/term-bank-parser.wasm',
    'dev/data/dictionary-wasm/manifest.json',
]

async function identity(root) {
    const digests = {}
    for (const relative of sourcePaths) digests[relative] = hash(await readFile(path.join(root, relative)))
    const trackedStatus = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=no'], {cwd: root, encoding: 'utf8'}).trim()
    assert.equal(trackedStatus, '', `${root}: tracked source must be clean`)
    return {
        root,
        commit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
        tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim(),
        trackedStatus,
        digests,
    }
}

async function arm(root) {
    const parser = await importAt(root, 'ext/js/dictionary/term-bank-wasm-parser.js')
    const lookup = await importAt(root, 'ext/js/dictionary/term-lookup-index-preparation.js')
    parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))))
    return {root, parser, lookup, identity: await identity(root)}
}

const options = {
    singleChunk: true,
    emitTermByteLists: false,
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    mediaHintFastScan: true,
    validateGlossaryTypes: true,
    prepareLookupIndexes: true,
}

async function parse(state, sources) {
    let result
    let count = 0
    await state.parser.parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
        count++
        if (!chunk.preparedLookupIndexes) {
            const prepared = state.lookup.prepareTermLookupIndexesFromPreinternedPlan(chunk, null, {})
            assert(prepared, 'Missing fallback lookup plan')
            chunk.preparedLookupIndexes = prepared.indexes
        }
        assert(state.lookup.hasCompletePreparedTermLookupIndexes(chunk.preparedLookupIndexes, chunk.rowCount))
        result = chunk
    }, 2048, options)
    assert.equal(count, 1, 'Every complete source group must produce one chunk')
    assert(result, 'Missing native result')
    state.parser.consumeLastTermBankWasmParseProfile()
    return result
}

function bytes(view) {
    return Buffer.from(view.buffer, view.byteOffset, view.byteLength)
}

function equalBytes(a, b, label) {
    assert.equal(a.constructor.name, b.constructor.name, `${label}: element type`)
    assert.equal(a.byteLength, b.byteLength, `${label}: byte length`)
    assert(bytes(a).equals(bytes(b)), `${label}: byte mismatch`)
}

function contentSpan(chunk) {
    const metadata = chunk.contentMetaList
    assert(metadata instanceof Uint32Array && metadata.length === chunk.rowCount * 4, 'Missing complete row metadata')
    assert(chunk.contentBytesBuffer instanceof Uint8Array, 'Missing native content slab')
    assert(Number.isSafeInteger(chunk.contentBytesBaseOffset), 'Missing slab base offset')
    let end = 0
    for (let row = 0; row < chunk.rowCount; row++) {
        const offset = metadata[row * 4]
        const length = metadata[row * 4 + 1]
        assert(length > 0 && offset + length <= chunk.contentBytesBuffer.byteLength - chunk.contentBytesBaseOffset)
        end = Math.max(end, offset + length)
    }
    if (chunk.contentBytesLength !== undefined) assert.equal(end, chunk.contentBytesLength, 'Slab extent differs from complete row references')
    return chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + end)
}

const first = await arm(baselineRoot)
const second = await arm(candidateRoot)
const report = {
    complete: false,
    node: process.version,
    boundary: 'Resident decoded term banks through native parser and complete prepared lookup outputs; excludes browser import/storage and media bytes',
    baseline: first.identity,
    candidate: second.identity,
    runnerSha256: hash(await readFile(fileURLToPath(import.meta.url))),
    lockSha256: hash(lockBytes),
    options,
    dictionaries: [],
}

await writeFile(destination, JSON.stringify(report, null, 2))
for (const [dictionary, filesPerGroup] of Object.entries(selected)) {
    const spec = lock.dictionaries[dictionary]
    const archive = await readFile(path.join(cacheRoot, spec.cacheFile))
    assert.equal(hash(archive), spec.sha256, `${dictionary}: fixture SHA-256`)
    assert.equal(archive.byteLength, spec.sizeBytes, `${dictionary}: fixture byte length`)
    const zip = new ZipReader(new Uint8ArrayReader(new Uint8Array(archive)))
    const digest = createHash('sha256')
    let rows = 0
    let groups = 0
    let mediaRows = 0
    let indexBytes = 0
    let canonicalBytes = 0
    let banks = 0
    try {
        const entries = (await zip.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        banks = entries.length
        for (let start = 0; start < entries.length; start += filesPerGroup) {
            const sources = []
            for (const entry of entries.slice(start, start + filesPerGroup)) {
                assert.equal(typeof entry.getData, 'function')
                sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
            }
            const a = await parse(first, sources)
            const b = await parse(second, sources)
            const label = `${dictionary} group ${groups}`
            assert.equal(a.rowCount, b.rowCount, `${label}: rows`)
            for (const name of ['contentRowStart', 'contentMetaByUniqueIndex', 'useResolvedContentReferences', 'contentBytesLength']) {
                assert.equal(a[name], b[name], `${label}: ${name}`)
            }
            for (const name of ['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList']) {
                equalBytes(a[name], b[name], `${label}: ${name}`)
                digest.update(bytes(a[name]))
            }
            assert.deepEqual(a.contentUniqueIndexList, b.contentUniqueIndexList, `${label}: exact content identities`)
            assert.deepEqual(a.contentDedupPlan, b.contentDedupPlan, `${label}: complete native deduplication plan and unique signatures`)
            assert.deepEqual(a.termRecordPreinternedPlan, b.termRecordPreinternedPlan, `${label}: complete source key plan`)
            const contentA = contentSpan(a)
            const contentB = contentSpan(b)
            equalBytes(contentA, contentB, `${label}: complete canonical content bytes`)
            digest.update(bytes(contentA))
            canonicalBytes += contentA.byteLength
            assert.deepEqual(a.mediaRows, b.mediaRows, `${label}: every projected media row and source glossary`)
            mediaRows += a.mediaRows.length
            assert.deepEqual([...a.preparedLookupIndexes.keys()], [...b.preparedLookupIndexes.keys()], `${label}: index segment identities`)
            for (const [key, indexA] of a.preparedLookupIndexes) {
                const indexB = b.preparedLookupIndexes.get(key)
                equalBytes(indexA.bytes, indexB.bytes, `${label}: index ${key}`)
                assert.deepEqual(indexA.preinternedPlan, indexB.preinternedPlan, `${label}: compact key plan ${key}`)
                indexBytes += indexA.bytes.byteLength
                digest.update(key)
                digest.update(bytes(indexA.bytes))
            }
            rows += a.rowCount
            groups++
        }
    } finally {
        await zip.close()
    }
    assert.equal(rows, spec.termRows, `${dictionary}: complete pinned row count`)
    report.dictionaries.push({dictionary, filesPerGroup, rows, banks, groups, mediaRows, indexBytes, canonicalBytes, outputSha256: digest.digest('hex'), archiveSha256: spec.sha256})
    await writeFile(destination, JSON.stringify(report, null, 2))
    console.log(`${dictionary}: ${rows} rows, ${banks} banks, exact content/hash/column/key/index/media-projection equality`)
}
assert.deepEqual(await identity(baselineRoot), first.identity, 'Baseline source changed during verification')
assert.deepEqual(await identity(candidateRoot), second.identity, 'Candidate source changed during verification')
report.complete = true
await writeFile(destination, JSON.stringify(report, null, 2))
