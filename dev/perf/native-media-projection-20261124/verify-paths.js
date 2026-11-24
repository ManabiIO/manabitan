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
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'
import {copyWasmBackedColumnChunk, parseTermBankWithWasmColumnChunks, setTermBankWasmModule} from '../../../ext/js/dictionary/term-bank-wasm-parser.js'
import {projectNativeMediaPaths} from '../../../ext/js/dictionary/term-bank-media-projection.js'
import {loadDictionaryFixtures} from '../dictionary-fixtures.js'

const [cache, destination, ...requested] = process.argv.slice(2)
assert(cache && destination, 'Usage: node verify-paths.js CACHE OUTPUT.json [vndb jitendex jmdict]')
const ids = requested.length > 0 ? requested : ['vndb', 'jitendex', 'jmdict']
const fixtures = await loadDictionaryFixtures()
const module = await WebAssembly.compile(await readFile(new URL('../../data/dictionary-wasm/term-bank-parser.wasm', import.meta.url)))
setTermBankWasmModule(module)

/**
 * Mirror the frozen production lazy-source partitioner. This is a correctness
 * replay, not browser timing; it runs the production-shaped groups serially.
 * @param {import('@zip.js/zip.js').Entry[]} entries
 * @param {number} totalBytes
 * @param {number} requestedCount
 * @returns {Array<import('@zip.js/zip.js').Entry[]>}
 */
function partition(entries, totalBytes, requestedCount) {
    const count = Math.min(entries.length, requestedCount)
    const groups = []
    let start = 0
    let consumed = 0
    for (let index = 0; index < count - 1; ++index) {
        const remaining = count - index
        const target = (totalBytes - consumed) / remaining
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

/**
 * @param {import('../../../ext/js/dictionary/term-bank-wasm-parser.js').TermBankColumnChunk} chunk
 * @returns {string}
 */
function hashLiveBuffers(chunk) {
    const hash = createHash('sha256')
    /**
     * @param {unknown} bytes
     */
    const append = (bytes) => {
        if (ArrayBuffer.isView(bytes)) {
            hash.update(String(bytes.byteLength) + ':')
            hash.update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
        }
    }
    for (const key of /** @type {const} */ (['readingEqualsExpressionList', 'scoreList', 'sequenceList', 'contentMetaList', 'contentUniqueIndexList'])) { append(chunk[key]) }
    const contentStart = chunk.contentBytesBaseOffset ?? 0
    append(chunk.contentBytesBuffer?.subarray(contentStart, contentStart + (chunk.contentBytesLength ?? 0)))
    for (const bytes of Object.values(chunk.termRecordPreinternedPlan)) { append(bytes) }
    for (const prepared of chunk.preparedLookupIndexes?.values() ?? []) {
        append(prepared.bytes)
        for (const bytes of Object.values(prepared.preinternedPlan)) { append(bytes) }
    }
    for (const {row} of chunk.mediaRows) {
        append(row.glossaryJsonBytes)
        append(row.expressionBytes)
        append(row.readingBytes)
    }
    return hash.digest('hex')
}

const reports = []
for (const id of ids) {
    const fixture = fixtures[id]
    assert(fixture, `Unknown fixture: ${id}`)
    const filename = path.join(cache, fixture.cacheFile)
    const archiveHash = createHash('sha256')
    let archiveBytes = 0
    for await (const value of createReadStream(filename)) {
        const bytes = /** @type {unknown} */ (value)
        assert(bytes instanceof Uint8Array)
        archiveHash.update(bytes)
        archiveBytes += bytes.length
    }
    assert.equal(archiveBytes, fixture.sizeBytes)
    assert.equal(archiveHash.digest('hex'), fixture.sha256)
    const reader = new ZipReader(new BlobReader(await openAsBlob(filename)), {useWebWorkers: false})
    try {
        const entries = (await reader.getEntries()).filter((entry) => /^term_bank_\d+\.json$/.test(entry.filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const sourceBytes = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
        const groups = partition(entries, sourceBytes, Math.max(id === 'jmdict' ? 12 : 9, Math.ceil(sourceBytes / (24 * 1024 * 1024))))
        const digest = createHash('sha256')
        const uniquePaths = new Set()
        const report = {id, fixtureSha256: fixture.sha256, banks: entries.length, groups: groups.length, sourceBytes, rows: 0, mediaRows: 0, nativeGroups: 0, nativeRows: 0, fallbackRows: 0, orderedPaths: 0, uniquePaths: 0, orderedPathSha256: '', completeChunkParity: true, liveBuffersUnchanged: true}
        for (let groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
            /** @type {Uint8Array[]} */
            const sources = []
            for (const entry of groups[groupIndex]) {
                assert(typeof entry.getData === 'function')
                sources.push(await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
            }
            await parseTermBankWithWasmColumnChunks(sources, 3, (chunk) => {
                // A shallow clone has no private scratch lease and exercises
                // the unchanged full-glossary JSON.parse collector.
                const reference = copyWasmBackedColumnChunk({...chunk}, true, true)
                const before = hashLiveBuffers(chunk)
                const native = projectNativeMediaPaths(chunk)
                const candidate = copyWasmBackedColumnChunk(chunk, true, true)
                assert.equal(hashLiveBuffers(chunk), before, `${id} group ${groupIndex}: borrowed input changed`)
                assert.deepStrictEqual(candidate, reference, `${id} group ${groupIndex}: complete chunk differs`)
                report.rows += chunk.rowCount
                report.mediaRows += chunk.mediaRows.length
                if (native !== null) { ++report.nativeGroups }
                for (let index = 0; index < chunk.mediaRows.length; ++index) {
                    if (native?.[index] === null || native === null) {
                        ++report.fallbackRows
                    } else {
                        ++report.nativeRows
                    }
                    const paths = candidate.mediaRows[index].imagePaths ?? []
                    const expected = reference.mediaRows[index].imagePaths ?? []
                    assert.deepStrictEqual(paths, expected)
                    digest.update(JSON.stringify([groupIndex, chunk.mediaRows[index].index, paths]) + '\n')
                    report.orderedPaths += paths.length
                    for (const value of paths) { uniquePaths.add(value) }
                }
            }, 2048, {
                singleChunk: true,
                emitTermByteLists: false,
                emitContentSlab: true,
                emitTokenBinaryContent: true,
                mediaHintFastScan: true,
                prepareLookupIndexes: true,
                projectImagePaths: true,
                validateGlossaryTypes: true,
                compactContentMetadata: true,
                experimentalNativeEscapedKeys: sourceBytes >= 512 * 1024 * 1024,
            })
            if ((groupIndex + 1) % 20 === 0 || groupIndex + 1 === groups.length) {
                process.stdout.write(JSON.stringify({id, completedGroups: groupIndex + 1, totalGroups: groups.length, rows: report.rows, nativeRows: report.nativeRows, fallbackRows: report.fallbackRows}) + '\n')
            }
        }
        assert.equal(report.rows, fixture.termRows)
        assert.equal(uniquePaths.size, fixture.mediaFiles ?? 0)
        if ((fixture.mediaFiles ?? 0) > 0) { assert(report.nativeRows > 0, 'Native path must actually activate') }
        report.uniquePaths = uniquePaths.size
        report.orderedPathSha256 = digest.digest('hex')
        reports.push(report)
        await mkdir(path.dirname(destination), {recursive: true})
        await writeFile(destination, JSON.stringify({scope: 'Complete native projection versus original JSON collector; not a timing benchmark', reports}, null, 4) + '\n')
    } finally { await reader.close() }
}
process.stdout.write(JSON.stringify({complete: true, reports}) + '\n')
