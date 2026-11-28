/*
 * Copyright (C) 2026  Manabitan authors
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
import {openAsBlob} from 'node:fs'
import {BlobReader, Uint8ArrayWriter, ZipReader} from '@zip.js/zip.js'
import {getImageMediaTypeFromFileName} from '../../ext/js/media/media-util.js'

const maxBatchFiles = 256
const maxBatchBytes = 8 * 1024 * 1024

/**
 * Verify every referenced image from the complete pinned archive through the
 * public media API, after import timing and a browser restart. Only the lock's
 * source-audited unused paths are excluded. Keep source ZIP reads file backed
 * and media requests bounded; do not retain a second decoded archive.
 * @param {string} archivePath
 * @param {Pick<import('./dictionary-fixtures.js').DictionaryFixture, 'expectedTitle'|'mediaFiles'|'mediaBytes'|'unreferencedMediaPaths'>} fixture
 * @param {(paths: string[]) => Promise<Array<{dictionary: string, path: string, content: string}>>} readMedia
 * @param {'all'|'sample'} [mode]
 * @returns {Promise<{mode: 'all'|'sample', totalFiles: number, totalBytes: number, files: number, bytes: number, sha256: string}>}
 */
export async function verifyBenchmarkMedia(archivePath, fixture, readMedia, mode = 'all') {
    assert(mode === 'all' || mode === 'sample', 'Unknown media verification mode')
    assert(Number.isSafeInteger(fixture.mediaFiles) && Number(fixture.mediaFiles) >= 0, 'Missing expected media count')
    assert(Number.isSafeInteger(fixture.mediaBytes) && Number(fixture.mediaBytes) >= 0, 'Missing expected media bytes')
    const unreferencedPaths = typeof fixture.unreferencedMediaPaths === 'undefined' ? [] : fixture.unreferencedMediaPaths
    assert(Array.isArray(unreferencedPaths) && unreferencedPaths.every((path) => typeof path === 'string' && path.length > 0), 'Invalid unreferenced media paths')
    const unreferenced = new Set(unreferencedPaths)
    assert.equal(unreferenced.size, unreferencedPaths.length, 'Duplicate unreferenced media paths')
    const reader = new ZipReader(new BlobReader(await openAsBlob(archivePath)), {useWebWorkers: false})
    try {
        const archiveEntries = (await reader.getEntries()).filter((entry) => !entry.directory && getImageMediaTypeFromFileName(entry.filename) !== null)
            .sort((a, b) => {
                if (a.filename === b.filename) { return 0 }
                return a.filename < b.filename ? -1 : 1
            })
        const archivePaths = new Set(archiveEntries.map((entry) => entry.filename))
        assert.equal(archivePaths.size, archiveEntries.length, 'Duplicate archive media paths')
        for (const path of unreferenced) { assert(archivePaths.has(path), `Unreferenced image is absent from archive: ${path}`) }
        assert.equal(archiveEntries.length, Number(fixture.mediaFiles) + unreferenced.size, 'Archive image count differs from lock')
        const entries = archiveEntries.filter((entry) => !unreferenced.has(entry.filename))
        assert.equal(entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0), fixture.mediaBytes, 'Referenced image bytes differ from lock')
        const selected = mode === 'all' || entries.length <= 64 ?
            entries :
            Array.from({length: 64}, (_, index) => entries[Math.floor(index * (entries.length - 1) / 63)])
        const digest = createHash('sha256')
        let bytes = 0
        for (let start = 0; start < selected.length;) {
            let end = start
            let batchBytes = 0
            while (end < selected.length && end - start < maxBatchFiles) {
                const size = selected[end].uncompressedSize
                if (end > start && batchBytes + size > maxBatchBytes) { break }
                batchBytes += size
                ++end
            }
            const batch = selected.slice(start, end)
            const actual = await readMedia(batch.map((entry) => entry.filename))
            assert.equal(actual.length, batch.length, 'Persisted media response count differs from archive')
            const byPath = new Map(actual.map((item) => [item.path, item]))
            assert.equal(byPath.size, actual.length, 'Persisted media response contains duplicate paths')
            for (const entry of batch) {
                const item = byPath.get(entry.filename)
                assert(item, `Missing persisted media: ${entry.filename}`)
                assert.equal(item.dictionary, fixture.expectedTitle, `Wrong media dictionary: ${entry.filename}`)
                assert.equal(typeof item.content, 'string', `Missing media bytes: ${entry.filename}`)
                assert(typeof entry.getData === 'function', `Unreadable archive media: ${entry.filename}`)
                const expected = await entry.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true})
                const actualBytes = Buffer.from(item.content, 'base64')
                assert.equal(actualBytes.byteLength, entry.uncompressedSize, `Persisted media length mismatch: ${entry.filename}`)
                assert(actualBytes.equals(expected), `Persisted media bytes differ from source: ${entry.filename}`)
                bytes += actualBytes.byteLength
                digest.update(JSON.stringify([entry.filename, actualBytes.byteLength, createHash('sha256').update(actualBytes).digest('hex')]) + '\n')
            }
            start = end
        }
        if (mode === 'all') { assert.equal(bytes, fixture.mediaBytes) }
        return {mode, totalFiles: entries.length, totalBytes: Number(fixture.mediaBytes), files: selected.length, bytes, sha256: digest.digest('hex')}
    } finally { await reader.close() }
}
