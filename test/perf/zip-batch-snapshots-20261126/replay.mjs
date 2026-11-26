#!/usr/bin/env node
/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {execFile, execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {createReadStream} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {parseArgs, promisify} from 'node:util'

const ownRoot = fileURLToPath(new URL('../../../', import.meta.url))
const {values} = parseArgs({options: {
    'baseline-root': {type: 'string'},
    'candidate-root': {type: 'string', default: ownRoot},
    'cache-dir': {type: 'string'},
    output: {type: 'string'},
}})
assert(values['baseline-root'] && values['cache-dir'] && values.output)
const output = path.resolve(values.output)
await mkdir(path.dirname(output), {recursive: true})
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const sourceFiles = [
    'ext/js/dictionary/term-bank-source-pipeline.js',
    'ext/js/dictionary/source-zip-media-preparation-worker.js',
    'ext/js/dictionary/source-zip-media-pack.js',
    'ext/js/dictionary/dense-zip-directory.js',
    'ext/js/dictionary/dictionary-generation-media-store.js',
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/media/media-util.js',
    'dev/data/dictionary-wasm/term-bank-parser.wasm',
]
const identities = async (root) => Object.fromEntries(await Promise.all(sourceFiles.map(async (file) => [file, sha256(await readFile(path.join(root, file)))])))
const lockBytes = await readFile(path.join(ownRoot, 'test/perf/dictionaries.lock.json'))
const fixture = JSON.parse(lockBytes).dictionaries.vndb
const archivePath = path.join(values['cache-dir'], fixture.cacheFile)
const fixtureDigest = createHash('sha256')
let fixtureBytes = 0
for await (const chunk of createReadStream(archivePath)) {
    fixtureBytes += chunk.length
    fixtureDigest.update(chunk)
}
assert.equal(fixtureBytes, fixture.sizeBytes)
assert.equal(fixtureDigest.digest('hex'), fixture.sha256)
const roots = {A: path.resolve(values['baseline-root']), B: path.resolve(values['candidate-root'])}
const worker = fileURLToPath(new URL('worker.mjs', import.meta.url))
const report = {
    schema: 1,
    complete: false,
    scope: 'Untimed exact-output comparison of the actual production source-media preparation worker in separate Node processes. Hashes every raw media payload and metadata tuple, then the complete final packed Blob and index. No browser import, timing, peak-memory or complete term-row claim.',
    node: process.version,
    fixture: {...fixture, lockSha256: sha256(lockBytes)},
    runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
    workerSha256: sha256(await readFile(worker)),
    sources: {},
    observations: {},
}
const save = async () => await writeFile(output, JSON.stringify(report, null, 2) + '\n')
const execute = promisify(execFile)
try {
    for (const [arm, root] of Object.entries(roots)) {
        report.sources[arm] = {
            head: execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
            files: await identities(root),
        }
    }
    for (const file of sourceFiles.slice(1)) { assert.equal(report.sources.A.files[file], report.sources.B.files[file], file) }
    assert.notEqual(report.sources.A.files[sourceFiles[0]], report.sources.B.files[sourceFiles[0]])
    await save()
    for (const [arm, root] of Object.entries(roots)) {
        console.log(`Checking ${arm}`)
        const {stdout, stderr} = await execute(process.execPath, [worker, root, archivePath], {timeout: 240000, maxBuffer: 1024 * 1024})
        await writeFile(`${output}.${arm}.stderr.txt`, stderr)
        report.observations[arm] = JSON.parse(stdout)
        assert.equal(report.observations[arm].raw.sourceCount, fixture.mediaFiles)
        assert.equal(report.observations[arm].descriptor.count, fixture.mediaFiles)
        assert.equal(report.observations[arm].metrics.uncompressedBytes, fixture.mediaBytes)
        await save()
    }
    assert.deepEqual(report.observations.A, report.observations.B)
    for (const [arm, root] of Object.entries(roots)) { assert.deepEqual(await identities(root), report.sources[arm].files) }
    assert.equal(sha256(await readFile(fileURLToPath(import.meta.url))), report.runnerSha256)
    assert.equal(sha256(await readFile(worker)), report.workerSha256)
    report.complete = true
    await save()
    console.log(JSON.stringify({complete: true, raw: report.observations.B.raw, indexSha256: report.observations.B.indexSha256, blobSha256: report.observations.B.blobSha256}))
} catch (error) {
    report.error = {message: String(error), stack: error?.stack, stdout: error?.stdout, stderr: error?.stderr}
    await save()
    throw error
}
