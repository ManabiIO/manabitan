/* Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const [root, archivePath] = process.argv.slice(2)
assert.equal(typeof globalThis.gc, 'function', 'Run the isolated process with --expose-gc')
// Source roots are explicit command-line inputs of the component comparison.
// eslint-disable-next-line no-unsanitized/method
const {DictionaryImporter} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/dictionary-importer.js')))
// eslint-disable-next-line no-unsanitized/method
const {DictionaryImporterMediaLoader} = await import(pathToFileURL(path.join(root, 'ext/js/dictionary/dictionary-importer-media-loader.js')))
const importer = new DictionaryImporter(new DictionaryImporterMediaLoader())
const archive = await openAsBlob(archivePath)
const query = [
    ['termFiles', /^term_bank_(\d+)\.json$/],
    ['termArtifactFiles', /^term_bank_(\d+)\.mbtb$/],
    ['termMetaFiles', /^term_meta_bank_(\d+)\.json$/],
    ['kanjiFiles', /^kanji_bank_(\d+)\.json$/],
    ['kanjiMetaFiles', /^kanji_meta_bank_(\d+)\.json$/],
    ['tagFiles', /^tag_bank_(\d+)\.json$/],
]
const settleGc = async () => {
    globalThis.gc()
    await new Promise((resolve) => { setImmediate(resolve) })
    globalThis.gc()
    return process.memoryUsage()
}
const before = await settleGc()
const cpuBefore = process.cpuUsage()
const started = performance.now()
const {fileMap, zipReader, catalog} = await importer._getFilesFromArchive(archive)
const catalogMs = performance.now() - started
assert.equal(catalog, 'dense-zip')
const classifiedStart = performance.now()
const classified = importer._getArchiveFiles(fileMap, query)
const index = fileMap.get('index.json')
assert(index)
const classifyMs = performance.now() - classifiedStart
const cpu = process.cpuUsage(cpuBefore)
const afterSelection = await settleGc()
const selectedCount = [...classified.values()].reduce((sum, list) => sum + list.length, 1)
const compact = fileMap._entries instanceof Map
const materializedAfterSelection = compact ? [...fileMap._entries.values()].filter((value) => typeof value !== 'number').length : fileMap.size
const compactBytesAfterSelection = compact ? fileMap._metadata.byteLength : 0
const hydrateStart = performance.now()
const all = [...fileMap.entries()]
const hydrateAllMs = performance.now() - hydrateStart
const afterAll = await settleGc()
const compactBytesAfterAll = compact ? fileMap._metadata.byteLength : 0
const checksum = createHash('sha256')
for (const [key, entry] of all) {
    assert.equal(typeof entry.getData, 'function')
    checksum.update(JSON.stringify([
        key,
        entry.filename,
        entry.offset,
        entry.compressedSize,
        entry.uncompressedSize,
        entry.compressionMethod,
        entry.signature,
        entry.encrypted,
        entry.directory,
        [...entry.rawFilename],
    ]))
}
const result = {
    catalogMs,
    classifyMs,
    catalogAndClassificationMs: catalogMs + classifyMs,
    catalogAndClassificationCpuMs: (cpu.user + cpu.system) / 1000,
    hydrateAllMs,
    before,
    afterSelection,
    afterAll,
    entryCount: fileMap.size,
    selectedCount,
    materializedAfterSelection,
    compactBytesAfterSelection,
    compactBytesAfterAll,
    metadataSha256: checksum.digest('hex'),
    selectedNames: Object.fromEntries([...classified].map(([kind, entries]) => [kind, entries.map(({filename}) => filename)])),
}
await zipReader.close()
console.log(JSON.stringify(result))
