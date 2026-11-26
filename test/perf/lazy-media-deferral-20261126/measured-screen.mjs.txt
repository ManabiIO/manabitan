#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {readDenseZipFileMap} from '../../../ext/js/dictionary/dense-zip-directory.js'
import {getImageMediaTypeFromFileName} from '../../../ext/js/media/media-util.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const runner = fileURLToPath(import.meta.url)
const [archivePath, arm] = process.argv.slice(2)
assert(archivePath, 'Usage: node screen.mjs /path/to/pinned/vndb_characters_by_bee.zip')

if (arm === 'baseline' || arm === 'candidate') {
    assert.equal(typeof globalThis.gc, 'function', 'Workers require --expose-gc')
    const archive = await openAsBlob(archivePath)
    const catalog = await readDenseZipFileMap(archive, async function unusedReader() { throw new Error('Unexpected payload read') })
    assert(catalog)
    const paths = []
    for (const filename of catalog.keys()) {
        if (getImageMediaTypeFromFileName(filename) === null) { catalog.get(filename) } else { paths.push(filename) }
    }
    const countMaterializedImages = () => paths.reduce((count, filename) => count + Number(typeof catalog._entries.get(filename) !== 'number'), 0)
    const beforeMaterialized = countMaterializedImages()
    for (let i = 0; i < 3; ++i) { globalThis.gc() }
    const before = process.memoryUsage()
    const started = performance.now()
    let admitted = 0
    for (const filename of paths) {
        if (arm === 'candidate') {
            if (catalog.hasArchiveEntry(filename)) { ++admitted }
        } else {
            const file = catalog.get(filename)
            if (typeof file !== 'undefined' && !Reflect.has(file, 'bytes')) { ++admitted }
        }
    }
    const elapsedMs = performance.now() - started
    for (let i = 0; i < 3; ++i) { globalThis.gc() }
    const after = process.memoryUsage()
    // Inspect after GC so neither arm can discard its retained catalog early.
    const afterMaterialized = countMaterializedImages()
    assert.equal(admitted, paths.length)
    assert.equal(beforeMaterialized, 0)
    assert.equal(afterMaterialized, arm === 'candidate' ? 0 : paths.length)
    const pathsSha256 = createHash('sha256').update(JSON.stringify(paths)).digest('hex')
    console.log(JSON.stringify({
        arm, elapsedMs, entries: catalog.size, images: paths.length, admitted, pathsSha256,
        beforeMaterialized, afterMaterialized,
        retainedHeapDelta: after.heapUsed - before.heapUsed,
        retainedArrayBufferDelta: after.arrayBuffers - before.arrayBuffers,
        retainedTotalDelta: after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers,
    }))
} else {
    const fixture = JSON.parse(await readFile(new URL('../../../test/perf/dictionaries.lock.json', import.meta.url), 'utf8')).dictionaries.vndb
    const digest = createHash('sha256')
    let sizeBytes = 0
    for await (const chunk of createReadStream(archivePath)) { digest.update(chunk); sizeBytes += chunk.length }
    assert.equal(sizeBytes, fixture.sizeBytes)
    assert.equal(digest.digest('hex'), fixture.sha256)
    const sourceFiles = ['ext/js/dictionary/dictionary-importer.js', 'ext/js/dictionary/dense-zip-file-map.js', 'ext/js/dictionary/dense-zip-directory.js']
    const sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, createHash('sha256').update(await readFile(pathToFileURL(path.join(root, file)))).digest('hex')])))
    const observations = []
    // Fresh catalogs/processes for every arm, with both execution orders.
    for (const label of 'ABBAABBAABBA') {
        const selected = label === 'A' ? 'baseline' : 'candidate'
        const result = JSON.parse(execFileSync(process.execPath, ['--expose-gc', runner, archivePath, selected], {encoding: 'utf8'}))
        assert.equal(result.images, fixture.mediaFiles)
        assert.equal(result.pathsSha256, observations[0]?.pathsSha256 ?? result.pathsSha256)
        observations.push(result)
    }
    const median = (values) => {
        const sorted = values.toSorted((a, b) => a - b)
        return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2
    }
    const summaries = Object.fromEntries(['baseline', 'candidate'].map((selected) => {
        const rows = observations.filter(({arm}) => arm === selected)
        return [selected, Object.fromEntries(['elapsedMs', 'retainedHeapDelta', 'retainedArrayBufferDelta', 'retainedTotalDelta'].map((metric) => [metric, median(rows.map((row) => row[metric]))]))]
    }))
    console.log(JSON.stringify({
        boundary: 'Production dense ZIP catalog on the locked archive; compare the previous get/bytes membership probe with the nonmaterializing predicate used during speculative image deferral. Non-image entries are opened before measurement. Measures one complete membership pass and post-GC retained Node heap plus ArrayBuffer deltas, not browser peak memory or complete-import latency. No image payload is read or validation bypassed by this component screen.',
        node: process.version, v8: process.versions.v8, fixture, sourceSha256,
        runnerSha256: createHash('sha256').update(await readFile(runner)).digest('hex'),
        schedule: 'ABBAABBAABBA', observations, summaries,
    }, null, 2))
}
