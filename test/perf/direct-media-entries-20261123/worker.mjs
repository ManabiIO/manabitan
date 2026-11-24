/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createWriteStream, openAsBlob} from 'node:fs'
import {readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import {pathToFileURL} from 'node:url'

const [root, archivePath, outputPrefix, phase, arm] = process.argv.slice(2)
// The CLI selects the local source checkout being checked against the baseline.
// eslint-disable-next-line no-unsanitized/method
const parser = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/term-bank-wasm-parser.js')))
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))))
const archive = await openAsBlob(archivePath)
let receive
let complete
const done = new Promise((resolve) => { complete = resolve })
globalThis.self = {
    addEventListener(type, handler) {
        assert.equal(type, 'message')
        assert.equal(receive, undefined)
        receive = handler
    },
    postMessage(result) {
        const elapsedMs = performance.now() - before
        const cpu = process.cpuUsage(cpuBefore)
        complete({result, measurement: {elapsedMs, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000}})
    },
}
// eslint-disable-next-line no-unsanitized/method
await import(pathToFileURL(path.join(root, 'ext/js/dictionary/source-zip-media-preparation-worker.js')))
assert.equal(typeof receive, 'function')
const cpuBefore = process.cpuUsage()
const before = performance.now()
receive({data: archive})
const {result, measurement} = await done
assert(result, 'Worker declined source media')
const indexSha256 = createHash('sha256').update(result.plan.index).digest('hex')
const identity = {descriptor: result.plan.descriptor, blobBytes: result.blob.size, indexSha256}
if (phase === 'oracle') {
    const digest = createHash('sha256')
    for await (const chunk of Readable.fromWeb(result.blob.stream())) { digest.update(chunk) }
    identity.blobIdentity = {sha256: digest.digest('hex'), bytes: result.blob.size}
    await writeFile(`${outputPrefix}-index.bin`, result.plan.index)
    if (arm === 'B') { await pipeline(Readable.fromWeb(result.blob.stream()), createWriteStream(path.join(path.dirname(outputPrefix), 'packed-media.bin'))) }
}
console.log(JSON.stringify({identity, metrics: result.metrics, measurement}))
