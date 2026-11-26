/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const [root, archivePath] = process.argv.slice(2)
// The CLI selects a local checkout root; callers below use fixed source paths.
// eslint-disable-next-line no-unsanitized/method
const load = async (file) => await import(pathToFileURL(path.join(root, file)))
const parser = await load('ext/js/dictionary/term-bank-wasm-parser.js')
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))))
const {RawZipPayloadReader} = await load('ext/js/dictionary/term-bank-source-pipeline.js')
const readBatch = RawZipPayloadReader.prototype.readBatch
const metadataDigest = createHash('sha256')
const payloadDigest = createHash('sha256')
let batches = 0
let sourceCount = 0
let sourceBytes = 0
let rangeReadCount = 0
let rangeReadBytes = 0
RawZipPayloadReader.prototype.readBatch = async function readBatchWithOracle(files, ...args) {
    const result = await readBatch.call(this, files, ...args)
    assert(result)
    const expectedFiles = [...files].sort((a, b) => a.offset - b.offset)
    assert.equal(result.sources.length, expectedFiles.length)
    ++batches
    rangeReadCount += result.rangeReadCount
    rangeReadBytes += result.rangeReadBytes
    for (let i = 0; i < result.sources.length; ++i) {
        const source = result.sources[i]
        assert.equal(source.file, expectedFiles[i])
        assert.deepEqual(Object.keys(source), ['file', 'archiveOffset', 'bytes', 'compressionMethod', 'compressedSize', 'uncompressedSize', 'signature', 'filename'])
        assert.equal(source.bytes.length, source.compressedSize)
        metadataDigest.update(JSON.stringify([source.filename, source.archiveOffset, source.compressionMethod, source.compressedSize, source.uncompressedSize, source.signature]) + '\n')
        payloadDigest.update(source.bytes)
        ++sourceCount
        sourceBytes += source.bytes.length
    }
    return result
}

let receive
let complete
const done = new Promise((resolve) => { complete = resolve })
globalThis.self = {
    addEventListener(type, handler) {
        assert.equal(type, 'message')
        assert.equal(receive, undefined)
        receive = handler
    },
    postMessage(result) { complete(result) },
}
await load('ext/js/dictionary/source-zip-media-preparation-worker.js')
assert.equal(typeof receive, 'function')
receive({data: await openAsBlob(archivePath)})
const result = await done
assert(result, 'Production worker declined the locked media archive')
const blobDigest = createHash('sha256')
for await (const bytes of result.blob.stream()) { blobDigest.update(bytes) }
const metrics = {...result.metrics}
delete metrics.readMs
delete metrics.validationMs
console.log(JSON.stringify({
    descriptor: result.plan.descriptor,
    indexBytes: result.plan.index.byteLength,
    indexSha256: createHash('sha256').update(result.plan.index).digest('hex'),
    blobBytes: result.blob.size,
    blobSha256: blobDigest.digest('hex'),
    raw: {
        batches,
        sourceCount,
        sourceBytes,
        rangeReadCount,
        rangeReadBytes,
        metadataSha256: metadataDigest.digest('hex'),
        payloadSha256: payloadDigest.digest('hex'),
    },
    metrics,
}))
