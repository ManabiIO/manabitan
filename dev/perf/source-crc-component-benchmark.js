/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {appendFile, mkdir, readFile, writeFile} from 'node:fs/promises'
import {execFileSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs} from 'node:util'
import {createHash} from 'node:crypto'
import {performance} from 'node:perf_hooks'
import {crc32, inflateRawSync} from 'node:zlib'
import {ZipReader, Uint8ArrayReader} from '@zip.js/zip.js'
import {RawZipPayloadReader} from '../../ext/js/dictionary/term-bank-source-pipeline.js'

/** @typedef {typeof import('../../ext/js/dictionary/term-bank-wasm-parser.js')} Parser */
/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} ColumnChunk */
/** @typedef {import('../../ext/js/dictionary/term-bank-wasm-parser.js').CompressedTermBankSource} Source */
/** @typedef {import('../../ext/js/dictionary/term-record-preinterned-plan.js').PreinternedTermRecordPlan} StringPlan */
/** @typedef {import('node:crypto').Hash} Hash */

const {values} = parseArgs({options: {
    'fixture': {type: 'string'},
    'fixture-sha256': {type: 'string'},
    'expected-rows': {type: 'string'},
    'baseline-wasm': {type: 'string'},
    'candidate-wasm': {type: 'string'},
    'output': {type: 'string'},
    'pairs': {type: 'string', default: '2'},
    'warmup-groups': {type: 'string', default: '12'},
    'project-image-paths': {type: 'boolean', default: false},
    'verify-source': {type: 'boolean', default: false},
    'limit-banks': {type: 'string', default: '0'},
}})
const fixture = values.fixture
const baseline = values['baseline-wasm']
const candidate = values['candidate-wasm']
assert.ok(fixture && baseline && candidate && values.output, 'Required: --fixture, --baseline-wasm, --candidate-wasm, --output')
const pairs = Number(values.pairs)
const warmupGroups = Number(values['warmup-groups'])
const limitBanks = Number(values['limit-banks'])
assert.ok(Number.isSafeInteger(pairs) && pairs > 0)
assert.ok(Number.isSafeInteger(warmupGroups) && warmupGroups >= 0)
assert.ok(Number.isSafeInteger(limitBanks) && limitBanks >= 0)
const expectedRows = values['expected-rows'] ? Number(values['expected-rows']) : null
assert.ok(expectedRows === null || (Number.isSafeInteger(expectedRows) && expectedRows > 0))
const reportPath = path.resolve(values.output)
await mkdir(path.dirname(reportPath), {recursive: true})
await writeFile(reportPath, '', {flag: 'wx'})
/** @param {unknown} value */
const emit = async (value) => {
    const line = `${JSON.stringify(value)}\n`
    await appendFile(reportPath, line)
    process.stdout.write(line)
}
/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
const hashBytes = (bytes) => createHash('sha256').update(bytes).digest('hex')
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const archive = Uint8Array.from(await readFile(fixture))
const zip = new ZipReader(new Uint8ArrayReader(archive), {useWebWorkers: false})
let files = (await zip.getEntries()).filter((file) => /^term_bank_\d+\.json$/.test(file.filename)).sort((a, b) => a.filename.localeCompare(b.filename, 'en', {numeric: true}))
if (limitBanks) { files = files.slice(0, limitBanks) }
assert.ok(files.length > 0, 'No term-bank sources')
const reader = new RawZipPayloadReader(new Blob([archive]))
/** @type {Source[]} */
const sources = await Promise.all(files.map(async (file) => {
    const compressionMethod = file.compressionMethod
    assert.ok(compressionMethod === 0 || compressionMethod === 8, 'Unsupported term-bank compression')
    return {...file, compressionMethod, bytes: await reader.read(file, new AbortController().signal)}
}))
const totalBytes = sources.reduce((total, source) => total + source.uncompressedSize, 0)
const groupCount = Math.min(sources.length, Math.max(12, Math.ceil(totalBytes / (24 * 1024 * 1024))))
/** @type {Source[][]} */
const groups = []
let start = 0
let consumed = 0
for (let index = 0; index < groupCount - 1; index++) {
    const remaining = groupCount - index
    const target = (totalBytes - consumed) / remaining
    let end = start + 1
    let bytes = sources[start].uncompressedSize
    const maxEnd = sources.length - (remaining - 1)
    while (end < maxEnd) {
        const next = bytes + sources[end].uncompressedSize
        if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
        bytes = next
        end++
    }
    groups.push(sources.slice(start, end))
    start = end
    consumed += bytes
}
groups.push(sources.slice(start))
const fixtureSha256 = hashBytes(archive)
if (values['fixture-sha256']) { assert.equal(fixtureSha256, values['fixture-sha256']) }
const oracle = values['verify-source'] ? {rows: 0, bytes: 0, crcChecks: 0} : null
if (oracle) {
    for (const source of sources) {
        const bytes = source.compressionMethod === 0 ? source.bytes : inflateRawSync(source.bytes)
        assert.equal(bytes.length, source.uncompressedSize)
        assert.equal(crc32(bytes), source.signature, source.filename)
        oracle.bytes += bytes.length
        // eslint-disable-next-line no-restricted-syntax -- Independent source oracle intentionally uses the platform JSON parser.
        const rows = /** @type {unknown} */ (JSON.parse(new TextDecoder().decode(bytes)))
        assert.ok(Array.isArray(rows), 'Expected a term-bank row array')
        oracle.rows += rows.length
        oracle.crcChecks++
    }
    if (expectedRows !== null) { assert.equal(oracle.rows, expectedRows) }
}
/** @type {Parser[]} */
const arms = []
const wasmIdentities = []
for (const [index, file] of [baseline, candidate].entries()) {
    // eslint-disable-next-line no-unsanitized/method, @typescript-eslint/no-unsafe-assignment -- Query-qualified copies of this fixed local module isolate the two parser caches.
    const parser = /** @type {Parser} */ (await import(`../../ext/js/dictionary/term-bank-wasm-parser.js?arm=${index}`))
    const bytes = await readFile(file)
    wasmIdentities.push({arm: index === 0 ? 'baseline' : 'candidate', bytes: bytes.length, sha256: hashBytes(bytes)})
    parser.setTermBankWasmModule(await WebAssembly.compile(bytes))
    await parser.initializeTermBankWasmParser()
    arms.push(parser)
}
/** @type {import('../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnParserOptions} */
const options = {
    experimentalNativeEscapedKeys: values['project-image-paths'] && totalBytes >= 512 * 1024 * 1024,
    projectImagePaths: values['project-image-paths'],
    computeContentHashes: true,
    emitContentSlab: true,
    emitTokenBinaryContent: true,
    emitTermByteLists: false,
    prepareLookupIndexes: true,
    useNativeStringPlan: true,
    validateGlossaryTypes: true,
    mediaHintFastScan: values['project-image-paths'],
    maxPendingChunks: 1,
    singleChunk: true,
}
const sourceFiles = ['dev/perf/source-crc-component-benchmark.js', 'ext/js/dictionary/term-bank-wasm-parser.js', 'ext/js/dictionary/term-bank-source-crc.js', 'ext/js/dictionary/term-bank-experiments.js']
const sourceIdentity = []
for (const file of sourceFiles) { sourceIdentity.push({file, sha256: hashBytes(await readFile(path.join(root, file)))}) }
await emit({type: 'configuration',
    schemaVersion: 2,
    startedAt: new Date().toISOString(),
    boundary: 'Common JavaScript adapter: source inflate through the first sink callback, including native CRC, parse, column projection and lookup preparation. No worker transport, storage, media import, browser startup, or UI.',
    digest: 'SHA-256 of framed field names, typed-array types, byte lengths, and values for all emitted term columns, string plans, content slabs, media rows and prepared lookup indexes.',
    groupRecipe: 'Byte-balanced source partitioning: min(bank count, max(12, ceil(source bytes / 24 MiB))).',
    exclusions: 'Source reads, module compilation, optional zlib/JSON oracle, and output digesting are outside timing. sourceCrcMs is included in parseMs.',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
    sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {cwd: root, encoding: 'utf8'}).trim(),
    sourceIdentity,
    wasmIdentities,
    fixture: {filename: path.basename(fixture), bytes: archive.length, sha256: fixtureSha256},
    sourceBanks: files.length,
    sourceBytes: totalBytes,
    groups: groups.map((group) => group.map((source) => source.filename)),
    options,
    pairs,
    warmupGroups,
    expectedRows,
    oracle,
    environment: {node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, cpus: os.availableParallelism(), cpuModel: os.cpus()[0]?.model, loadAverage: os.loadavg()}})
// Digest the complete consumed values while the borrowed WASM views are valid.
// Names, types and byte lengths prevent adjacent fields from being ambiguous.
/**
 * @param {Hash} hash
 * @param {string} name
 * @param {unknown} value
 */
function digestPart(hash, name, value) {
    const type = ArrayBuffer.isView(value) ? value.constructor.name : typeof value
    const bytes = ArrayBuffer.isView(value) ?
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength) :
        Buffer.from(typeof value === 'undefined' ? '' : JSON.stringify(value))
    hash.update(`${name}:${type}:${bytes.byteLength}:`)
    hash.update(bytes)
}

/**
 * @param {Hash} hash
 * @param {string} name
 * @param {StringPlan} plan
 */
function digestPlan(hash, name, plan) {
    for (const key of /** @type {const} */ (['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes'])) {
        digestPart(hash, `${name}.${key}`, plan[key])
    }
}

/**
 * @param {Hash} hash
 * @param {ColumnChunk} chunk
 */
function digestChunk(hash, chunk) {
    for (const key of /** @type {const} */ (['rowCount', 'contentRowStart', 'readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList', 'contentHash1List', 'contentHash2List', 'useResolvedContentReferences'])) {
        digestPart(hash, key, chunk[key])
    }
    digestPlan(hash, 'termRecordPreinternedPlan', chunk.termRecordPreinternedPlan)
    assert.ok(chunk.contentBytesBuffer && typeof chunk.contentBytesBaseOffset === 'number' && typeof chunk.contentBytesLength === 'number' && Number.isSafeInteger(chunk.contentBytesLength), 'Expected one complete encoded-content slab')
    digestPart(hash, 'contentBytes', chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + chunk.contentBytesLength))
    digestPart(hash, 'mediaRows.length', chunk.mediaRows.length)
    for (const item of chunk.mediaRows) {
        digestPart(hash, 'mediaRow.index', item.index)
        digestPart(hash, 'mediaRow.imagePaths', item.imagePaths)
        const row = /** @type {Record<string, unknown>} */ (item.row)
        for (const key of Object.keys(row).sort()) { digestPart(hash, `mediaRow.${key}`, row[key]) }
    }
    digestPart(hash, 'preparedLookupIndexes.size', chunk.preparedLookupIndexes?.size ?? 0)
    for (const [key, prepared] of chunk.preparedLookupIndexes ?? []) {
        digestPart(hash, 'prepared.key', key)
        digestPart(hash, 'prepared.bytes', prepared.bytes)
        digestPlan(hash, 'prepared.plan', prepared.preinternedPlan)
    }
}

/** @type {string|undefined} */
let expectedDigest
/**
 * @param {number} index
 * @param {Source[][]} selectedGroups
 * @param {string} label
 */
async function run(index, selectedGroups, label) {
    const parser = arms[index]
    const hash = createHash('sha256')
    const result = {label, index, nativeMs: 0, userMs: 0, systemMs: 0, inflateMs: 0, crcMs: 0, parseMs: 0, fallbackGroups: 0, crcReusedBytes: 0, crcScannedBytes: 0, crcReusedGlossaries: 0, rows: 0, sourceBytes: 0, groups: selectedGroups.length}
    for (const group of selectedGroups) {
        let emitted = 0
        const cpuStart = process.cpuUsage()
        // eslint-disable-next-line no-restricted-syntax -- The standalone Node benchmark uses the platform monotonic clock.
        const startedAt = performance.now()
        const preloaded = await parser.inflateCompressedTermBankSourcesWasm(group, options, true)
        await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (chunk) => {
            // eslint-disable-next-line no-restricted-syntax -- The standalone Node benchmark uses the platform monotonic clock.
            result.nativeMs += performance.now() - startedAt
            const cpu = process.cpuUsage(cpuStart)
            result.userMs += cpu.user / 1000
            result.systemMs += cpu.system / 1000
            assert.equal(emitted++, 0, 'singleChunk must emit at most one chunk')
            result.rows += chunk.rowCount
            digestPart(hash, 'sourceBanks', group.map((source) => source.filename))
            digestChunk(hash, chunk)
        }, 2048, {...options, preloadedSource: preloaded})
        if (emitted === 0) {
            // eslint-disable-next-line no-restricted-syntax -- The standalone Node benchmark uses the platform monotonic clock.
            result.nativeMs += performance.now() - startedAt
            const cpu = process.cpuUsage(cpuStart)
            result.userMs += cpu.user / 1000
            result.systemMs += cpu.system / 1000
            digestPart(hash, 'emptySourceBanks', group.map((source) => source.filename))
        }
        const profile = parser.consumeLastTermBankWasmParseProfile()
        assert.ok(profile)
        result.inflateMs += preloaded.inflateMs
        result.crcMs += preloaded.crcMs ?? 0
        result.crcReusedBytes += preloaded.crcReusedBytes ?? 0
        result.crcScannedBytes += preloaded.crcScannedBytes ?? 0
        result.crcReusedGlossaries += preloaded.crcReusedGlossaryCount ?? 0
        result.parseMs += profile.parseBankMs
        result.fallbackGroups += profile.fusedParseFallbacks ?? 0
        result.sourceBytes += preloaded.uncompressedBytes
    }
    const digest = hash.digest('hex')
    if (label !== 'warmup') {
        if (expectedDigest) {
            assert.equal(digest, expectedDigest)
        } else {
            expectedDigest = digest
        }
    }
    if (label !== 'warmup' && expectedRows !== null) { assert.equal(result.rows, expectedRows) }
    await emit({type: 'run', finishedAt: new Date().toISOString(), ...result, digest})
}
await run(0, groups.slice(0, warmupGroups), 'warmup')
await run(1, groups.slice(0, warmupGroups), 'warmup')
for (let pair = 0; pair < pairs; pair++) {
    for (const index of pair % 2 === 0 ? [0, 1] : [1, 0]) { await run(index, groups, `pair-${pair}`) }
}
await emit({type: 'complete', completedAt: new Date().toISOString(), expectedDigest})
await zip.close()
