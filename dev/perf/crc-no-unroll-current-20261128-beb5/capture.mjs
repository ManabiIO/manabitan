/* SPDX-License-Identifier: GPL-3.0-or-later */
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'
import {BlobReader, ZipReader} from '@zip.js/zip.js'
import {RawZipPayloadReader} from '../../../ext/js/dictionary/term-bank-source-pipeline.js'
import {getImageMediaTypeFromFileName} from '../../../ext/js/media/media-util.js'
import {loadDictionaryWasm} from '../../dictionary-wasm.js'
import {writeConformanceCases} from './fixtures.mjs'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const [cacheArg, outputArg] = process.argv.slice(2)
assert(cacheArg && outputArg, 'Provide archive cache and a fresh capture directory')
const output = resolve(outputArg)
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const baseline = 'dcfc02a0a5534929b1e9fa1f2801ec7a0784ea16'
const lockBytes = await readFile(join(root, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries.jmdict
assert.equal(sha256(lockBytes), sha256(execFileSync('git', ['show', `${baseline}:test/perf/dictionaries.lock.json`], {cwd: root})))
const archivePath = join(resolve(cacheArg), fixture.cacheFile)
const archiveHash = createHash('sha256')
let archiveSize = 0
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes); archiveSize += bytes.length }
assert.equal(archiveHash.digest('hex'), fixture.sha256)
assert.equal(archiveSize, fixture.sizeBytes)
await mkdir(output, {recursive: false})

// Reproduce the current ordinary three-worker, four-group policy; the screen
// executes these exact partitions serially across three fresh worker instances.
function partition(entries) {
    const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    const count = Math.min(entries.length, Math.max(3 * 4, Math.ceil(total / (24 * 1024 * 1024))))
    const groups = []
    let start = 0
    let consumed = 0
    for (let index = 0; index < count - 1; ++index) {
        const remaining = count - index
        const target = (total - consumed) / remaining
        let end = start + 1
        let bytes = entries[start].uncompressedSize
        const maxEnd = entries.length - (remaining - 1)
        while (end < maxEnd) {
            const next = bytes + entries[end].uncompressedSize
            if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
            bytes = next
            ++end
        }
        groups.push(entries.slice(start, end))
        start = end
        consumed += bytes
    }
    groups.push(entries.slice(start))
    return groups
}

const archive = await openAsBlob(archivePath)
const zip = new ZipReader(new BlobReader(archive), {useWebWorkers: false})
const catalog = await zip.getEntries()
assert(!catalog.some((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null))
const entries = catalog.filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
    .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
assert.equal(entries.length, 53)
const reader = new RawZipPayloadReader(archive)
const signal = new AbortController().signal
const groups = []
let totalRows = 0
try {
    for (const [groupIndex, group] of partition(entries).entries()) {
        assert(group.length > 1, 'Screen requires the exact production multi-bank span path')
        const decodedHash = createHash('sha256')
        const banks = []
        let rows = 0
        for (const entry of group) {
            const bytes = await reader.read(entry, signal)
            assert.equal(entry.compressionMethod, 8)
            const inflated = inflateRawSync(bytes, {info: true})
            const decoded = inflated.buffer
            assert.equal(inflated.engine.bytesWritten, bytes.byteLength)
            assert.equal(decoded.byteLength, entry.uncompressedSize)
            assert.equal(crc32(decoded), entry.signature)
            const parsed = JSON.parse(decoded.toString('utf8'))
            assert(Array.isArray(parsed))
            rows += parsed.length
            const filename = `${entry.filename}.deflate`
            await writeFile(join(output, filename), bytes, {flag: 'wx'})
            decodedHash.update(decoded)
            banks.push({filename, zipFilename: entry.filename, compressionMethod: entry.compressionMethod,
                compressedSize: bytes.length, uncompressedSize: decoded.length, signature: entry.signature,
                compressedSha256: sha256(bytes), decodedSha256: sha256(decoded), rows: parsed.length})
        }
        const compressedBytes = banks.reduce((sum, bank) => sum + bank.compressedSize, 0)
        const decodedBytes = banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0)
        const crcReuseEligible = banks.length > 1 && decodedBytes >= 4 * 1024 * 1024 && compressedBytes <= Math.floor(decodedBytes / 32)
        assert(!crcReuseEligible, 'This initial screen must not replace deferred-CRC production work with immediate CRC')
        totalRows += rows
        groups.push({groupIndex, rows, compressedBytes, decodedBytes, crcReuseEligible,
            decodedSha256: decodedHash.digest('hex'), banks})
    }
} finally { await zip.close() }
assert.equal(totalRows, fixture.termRows)
assert.equal(groups.length, 12)
const modules = loadDictionaryWasm()
const moduleBytes = modules.get('term-bank-parser.wasm')
const manifest = {
    format: 1, dictionary: 'jmdict', baseline, archiveSha256: fixture.sha256, archiveBytes: archiveSize,
    lockSha256: sha256(lockBytes), wasmSha256: sha256(moduleBytes),
    captureSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    oracle: 'Node zlib raw inflate with consumed-input count, exact ZIP size, native Node CRC32, complete decoded SHA-256, and independent JSON row count; no browser algorithm prewarming',
    scope: 'Every pinned JMdict source bank, in all 12 unchanged ordinary three-worker byte-balanced groups; one-group-at-a-time component execution',
    grouping: {parserWorkers: 3, groupsPerWorker: 4, targetBytes: 24 * 1024 * 1024, executionConcurrency: 1},
    totalRows, compressedBytes: groups.reduce((sum, group) => sum + group.compressedBytes, 0),
    decodedBytes: groups.reduce((sum, group) => sum + group.decodedBytes, 0), groups,
}
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx'})
await writeConformanceCases(output, moduleBytes)
console.log(JSON.stringify({dictionary: 'jmdict', groups: groups.length, banks: entries.length, rows: totalRows,
    compressedBytes: manifest.compressedBytes, decodedBytes: manifest.decodedBytes, allImmediateCrc: true}))
