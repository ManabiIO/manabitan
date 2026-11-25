/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFileSync, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob, readFileSync, statSync, writeFileSync} from 'node:fs'
import path from 'node:path'
import {setImmediate} from 'node:timers/promises'
import {fileURLToPath, pathToFileURL} from 'node:url'

const ownFile = fileURLToPath(import.meta.url)
const filename = 'ext/js/dictionary/dense-zip-directory.js'
const archiveSha256 = 'da5baed5332761513dcef8d0b07ad0d9201cdd7f37831dea37e7162994ec3792'
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

if (process.argv[2] === '--child') {
    const [source, archivePath] = process.argv.slice(3)
    // Both paths are selected by the parent CLI, never by dictionary contents.
    // eslint-disable-next-line no-unsanitized/method
    const {readDenseZipDirectory} = await import(pathToFileURL(source))
    const archive = await openAsBlob(archivePath)
    for (let warmup = 0; warmup < 2; ++warmup) {
        let entries = await readDenseZipDirectory(archive)
        assert.equal(entries?.length, 147237)
        entries = null
        await setImmediate()
    }
    global.gc()
    await setImmediate()
    global.gc()
    const before = process.memoryUsage()
    const entries = await readDenseZipDirectory(archive)
    assert.equal(entries?.length, 147237)
    await setImmediate()
    global.gc()
    await setImmediate()
    global.gc()
    const after = process.memoryUsage()
    const digest = createHash('sha256')
    let filenameBytes = 0
    let retainedRawNameViews = 0
    for (const entry of entries) {
        const raw = entry.rawFilename
        filenameBytes += raw.byteLength
        if (Object.hasOwn(entry, 'rawFilename')) { ++retainedRawNameViews }
        digest.update(JSON.stringify([entry.filename, entry.offset, entry.compressedSize, entry.uncompressedSize, entry.compressionMethod, entry.signature, entry.encrypted, entry.directory]))
        digest.update(raw)
    }
    assert.equal(filenameBytes, 2400540)
    console.log(JSON.stringify({
        sourceSha256: sha256(readFileSync(source)),
        count: entries.length,
        filenameBytes,
        retainedRawNameViews,
        digest: digest.digest('hex'),
        before,
        after,
        delta: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
    }))
} else {
    const [baselineRoot, candidateRoot, archivePath, outputPath] = process.argv.slice(2)
    assert(
        baselineRoot && candidateRoot && archivePath && outputPath,
        'Usage: node test/perf/dense-zip-catalog-memory.mjs BASELINE_ROOT CANDIDATE_ROOT ARCHIVE OUTPUT_JSON',
    )
    assert.equal(statSync(archivePath).size, 291705969)
    const archiveHash = createHash('sha256')
    for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
    assert.equal(archiveHash.digest('hex'), archiveSha256)
    const roots = {A: path.resolve(baselineRoot), B: path.resolve(candidateRoot)}
    const sources = Object.fromEntries(Object.entries(roots).map(([arm, root]) => [arm, {
        root,
        head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
        source: path.join(root, filename),
        sha256: sha256(readFileSync(path.join(root, filename))),
    }]))
    const report = {
        complete: false,
        node: process.version,
        v8: process.versions.v8,
        archiveSha256,
        sourceIdentity: sources,
        runnerSha256: sha256(readFileSync(ownFile)),
        protocol: 'Four fixed alternating AB/BA pairs. Fresh process per observation; two discarded catalog warmups; settle and GC before and after retaining one catalog. No timing measurement.',
        observations: [],
    }
    const save = () => writeFileSync(outputPath, JSON.stringify(report, null, 4) + '\n')
    save()
    try {
        for (let pair = 0; pair < 4; ++pair) {
            for (const arm of pair % 2 ? ['B', 'A'] : ['A', 'B']) {
                const child = spawnSync(process.execPath, ['--expose-gc', ownFile, '--child', sources[arm].source, archivePath], {encoding: 'utf8'})
                assert.equal(child.status, 0, child.stderr)
                const result = JSON.parse(child.stdout)
                assert.equal(result.sourceSha256, sources[arm].sha256)
                report.observations.push({pair, arm, ...result})
                save()
            }
        }
        assert.equal(new Set(report.observations.map((row) => row.digest)).size, 1)
        for (const source of Object.values(sources)) { assert.equal(sha256(readFileSync(source.source)), source.sha256) }
        const get = (arm) => report.observations.filter((row) => row.arm === arm).map((row) => row.delta.heapUsed)
        const a = get('A')
        const b = get('B')
        report.pairs = a.map((value, pair) => ({pair, baselineHeapBytes: value, candidateHeapBytes: b[pair], reductionBytes: value - b[pair], reductionPercent: (1 - b[pair] / value) * 100}))
        report.complete = true
    } catch (error) {
        report.error = String(error)
        throw error
    } finally {
        save()
    }
    console.log(JSON.stringify({complete: true, pairs: report.pairs}, null, 2))
}
