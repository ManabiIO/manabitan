/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

// Complete importer replay with external persistence and Worker-result
// adapters. Invoke through compact-media-corpus-replay.py for independent ZIP
// and JSON oracles, frozen source identities and baseline/candidate comparison.
import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {openAsBlob} from 'node:fs'
import {readFile} from 'node:fs/promises'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'

function digestLines(values) {
    const hash = createHash('sha256')
    for (const value of values) { hash.update(JSON.stringify(value) + '\n') }
    return hash.digest('hex')
}

function importLocalModule(url) {
    assert.equal(new URL(url).protocol, 'file:')
    // The operator selects the checkout; every relative module name is fixed.
    // eslint-disable-next-line no-unsanitized/method
    return import(url)
}

function installFileFetch() {
    const original = globalThis.fetch
    globalThis.fetch = async (resource, options) => {
        const url = resource instanceof URL ? resource : new URL(typeof resource === 'string' ? resource : resource.url)
        if (url.protocol !== 'file:') { return original(resource, options) }
        return new Response(await readFile(fileURLToPath(url)), {headers: {'Content-Type': 'application/wasm'}})
    }
}

// Run the unchanged source worker's directory, packer and CRC path before the
// import begins. This is an explicit external-worker-result adapter: no timing,
// worker transfer, concurrent parser-state, browser or OPFS claim is made.
async function prepareSourceMedia(moduleUrl, archive) {
    let listener
    let settle
    const result = new Promise((resolve) => { settle = resolve })
    const originalSelf = globalThis.self
    globalThis.self = {
        addEventListener(type, handler) {
            assert.equal(type, 'message')
            listener = handler
        },
        postMessage(data) { settle(data) },
    }
    try {
        await importLocalModule(moduleUrl)
        listener({data: archive})
        return await result
    } finally { globalThis.self = originalSelf }
}

async function runImporter() {
    const [rootInput, archivePath, fixtureId, workerMode = 'prepared'] = process.argv.slice(2)
    assert(rootInput && archivePath && fixtureId, 'Arguments: repository archive fixture [prepared|decline]')
    const root = resolve(rootInput)
    const moduleUrl = (name) => pathToFileURL(resolve(root, name)).href
    installFileFetch()
    const {dictionaries} = JSON.parse(await readFile(resolve(root, 'test/perf/dictionaries.lock.json'), 'utf8'))
    const fixture = dictionaries[fixtureId]
    assert(fixture)
    const archive = await openAsBlob(archivePath)
    assert.equal(archive.size, fixture.sizeBytes)
    const workerReport = {started: 0, prepared: false, selectedImages: 0}
    const prepared = workerMode === 'prepared' && fixture.mediaFiles >= 8192 ?
        await prepareSourceMedia(moduleUrl('ext/js/dictionary/source-zip-media-preparation-worker.js'), archive) :
        null
    globalThis.Worker = class {
        constructor(url) {
            assert.equal(new URL(url).pathname.split('/').pop(), 'source-zip-media-preparation-worker.js', 'Parser workers are unavailable in this replay')
            ++workerReport.started
        }

        postMessage(value) {
            assert.equal(value, archive)
            queueMicrotask(() => {
                if (prepared !== null) {
                    workerReport.prepared = true
                    workerReport.selectedImages = prepared.plan.descriptor.count
                }
                this.onmessage?.({data: prepared})
            })
        }

        terminate() {}
    }
    const {DictionaryImporter} = await importLocalModule(moduleUrl('ext/js/dictionary/dictionary-importer.js'))
    const {DenseZipFileMap} = await importLocalModule(moduleUrl('ext/js/dictionary/dense-zip-file-map.js'))
    const {getImageMediaTypeFromFileName} = await importLocalModule(moduleUrl('ext/js/media/media-util.js'))
    const importer = new DictionaryImporter({async getImageDetails() { throw new Error('Image metadata was not skipped') }})
    const materialization = {initialImages: 0, createdAll: 0, createdImages: 0, atLastTermSink: 0, beforeDeferredDrain: null, finalImages: 0}
    let catalog
    let catalogType
    let archiveCatalog
    let catalogEntryCount
    const openArchive = importer._getFilesFromArchive.bind(importer)
    importer._getFilesFromArchive = async (...args) => {
        const result = await openArchive(...args)
        catalog = result.fileMap
        const compact = catalog instanceof DenseZipFileMap
        catalogType = compact ? 'DenseZipFileMap' : 'Map'
        archiveCatalog = result.catalog
        catalogEntryCount = catalog.size
        if (!compact) {
            const images = new Set()
            for (const path of catalog.keys()) {
                if (getImageMediaTypeFromFileName(path) !== null) { images.add(catalog.get(path)) }
            }
            materialization.initialImages = images.size
        }
        const get = catalog.get.bind(catalog)
        catalog.get = (path) => {
            // Instrument the representation transition independently of the
            // candidate's new predicate; never call values()/entries().
            const pending = compact && typeof catalog._entries.get(path) === 'number'
            const entry = get(path)
            if (pending) {
                ++materialization.createdAll
                if (getImageMediaTypeFromFileName(path) !== null) { ++materialization.createdImages }
            }
            return entry
        }
        return result
    }
    const requirements = new Set()
    const requirementOrderHash = createHash('sha256')
    const assignRequirement = importer._assignRequirementNoMetadata.bind(importer)
    importer._assignRequirementNoMetadata = (requirement) => {
        const path = requirement.source.path
        // This boundary sees both prefetch and deferred references. Observing
        // only _createDeferredMediaRequirement would omit ordinary-map images
        // that fit in the existing initial prefetch budget.
        if (!requirements.has(path)) {
            requirements.add(path)
            requirementOrderHash.update(JSON.stringify([requirement.type, path, requirement.entry.dictionary]) + '\n')
        }
        return assignRequirement(requirement)
    }
    let deferredDrain = null
    const drain = importer._importDeferredMediaRequirements.bind(importer)
    importer._importDeferredMediaRequirements = async (...args) => {
        materialization.beforeDeferredDrain = materialization.initialImages + materialization.createdImages
        deferredDrain = {requirements: args[0].length, prefetched: args[1].length, cachedBatchReads: args[4]?.supportsCachedBatchReads() === true}
        return drain(...args)
    }
    const mediaRows = new Map()
    let mediaBytes = 0
    const rememberMedia = (path, content) => {
        assert(!mediaRows.has(path), `Duplicate media output: ${path}`)
        const bytes = content instanceof ArrayBuffer ? new Uint8Array(content) : content
        mediaBytes += bytes.byteLength
        mediaRows.set(path, [path, bytes.byteLength, createHash('sha256').update(bytes).digest('hex')])
    }
    let publishedPlan = null
    let stagedBlob = null
    let termRows = 0
    let nativeTermChunks = 0
    const noteTerms = (count) => {
        termRows += count
        materialization.atLastTermSink = materialization.initialImages + materialization.createdImages
    }
    const db = {
        isPrepared: () => true,
        setImportOptimizationFlags() {},
        setTermEntryContentDedupEnabled() {},
        setImportDebugLogging() {},
        dictionaryExists: async () => false,
        addWithResult: async () => 1,
        startBulkImport: async () => 'corpus-media-replay',
        finishBulkImport: async () => ({}),
        abortBulkImport: async () => {},
        deleteDictionaryImportPlaceholder: async () => {},
        getLastBulkAddTermsMetrics: () => null,
        queuePendingTermContentImportWrites: async () => {},
        queuePendingTermRecordImportWrites: async () => {},
        canWriteGenerationMedia: () => true,
        stageGenerationMediaPayload(blob) {
            stagedBlob = blob
            return {
                async seal(plan) { publishedPlan = {blob, plan} },
                async discard() { stagedBlob = null },
            }
        },
        async writeGenerationMedia(blob, plan) { publishedPlan = {blob, plan}; return true },
        async bulkAdd(store, entries, start, count) {
            if (store === 'terms') { noteTerms(count) }
            if (store === 'media') {
                for (let i = start; i < start + count; ++i) {
                    assert.equal(entries[i].dictionary, fixture.expectedTitle)
                    rememberMedia(entries[i].path, entries[i].content)
                }
            }
        },
        async bulkAddArtifactTermsChunk(chunk) { ++nativeTermChunks; noteTerms(chunk.rowCount) },
    }
    const result = await importer.importDictionary(db, archive, {skipImageMetadata: true, zipUseWebWorkers: false})
    assert.deepEqual(result.errors.map((error) => error.message), [])
    assert(result.result)
    assert.equal(result.result.title, fixture.expectedTitle)
    assert.equal(termRows, fixture.termRows)
    assert.equal(result.result.counts.media.total, fixture.mediaFiles)
    materialization.finalImages = materialization.initialImages + materialization.createdImages
    const route = publishedPlan === null ? 'decoded-rows' : 'generation-plan'
    if (publishedPlan !== null) {
        assert.equal(mediaRows.size, 0)
        const {blob, plan} = publishedPlan
        assert.equal(blob.size, plan.descriptor.dataBytes)
        const {descriptor, index} = plan
        assert.equal(descriptor.version, 2)
        assert.equal(index.byteLength, descriptor.slotCount * 24)
        const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
        const records = []
        for (let slot = 0; slot < descriptor.slotCount; ++slot) {
            const row = slot * 24
            assert.equal(view.getUint32(row + 20, true), crc32(index.subarray(row, row + 20)))
            assert.equal(view.getUint32(row + 16, true), descriptor.firstId + slot)
            const marker = view.getUint32(row, true)
            if (marker === 0) {
                assert.equal(view.getUint32(row + 4, true), 0)
                assert.equal(view.getUint32(row + 8, true), 0)
                assert.equal(view.getUint32(row + 12, true), 0)
                continue
            }
            const word = view.getUint32(row + 4, true)
            const record = {
                path: descriptor.prefix + (descriptor.firstId + slot) + descriptor.suffix,
                offset: marker - 1,
                length: word & 0x7fffffff,
                deflated: (word >>> 31) === 1,
                outputLength: view.getUint32(row + 8, true),
                signature: view.getUint32(row + 12, true),
            }
            assert(record.length > 0 && record.length <= 4 * 1024 * 1024)
            assert(record.outputLength > 0 && record.outputLength <= 4 * 1024 * 1024)
            assert(record.offset >= 0 && record.offset + record.length <= blob.size)
            records.push(record)
        }
        assert.equal(records.length, descriptor.count)
        records.sort((a, b) => a.offset - b.offset)
        for (let start = 0; start < records.length;) {
            let end = start + 1
            const lower = records[start].offset
            let upper = lower + records[start].length
            while (end < records.length && records[end].offset + records[end].length - lower <= 4 * 1024 * 1024) {
                upper = records[end].offset + records[end].length
                ++end
            }
            const packed = new Uint8Array(await blob.slice(lower, upper).arrayBuffer())
            for (let i = start; i < end; ++i) {
                const record = records[i]
                const compressed = packed.subarray(record.offset - lower, record.offset - lower + record.length)
                const content = record.deflated ? inflateRawSync(compressed) : compressed
                assert.equal(content.byteLength, record.outputLength)
                assert.equal(crc32(content), record.signature)
                rememberMedia(record.path, content)
            }
            start = end
        }
    }
    assert.equal(mediaRows.size, fixture.mediaFiles)
    assert.equal(mediaBytes, fixture.mediaBytes)
    const imagePaths = [...requirements].sort()
    assert.deepEqual([...mediaRows.keys()].sort(), imagePaths)
    const report = {
        fixture: fixtureId,
        runtime: {node: process.version, v8: process.versions.v8, zlib: process.versions.zlib},
        termRows,
        nativeTermChunks,
        counts: result.result.counts,
        materialization,
        requirements: {uniqueImagePaths: requirements.size, imagePathsSha256: digestLines(imagePaths), orderSha256: requirementOrderHash.digest('hex')},
        media: {route, count: mediaRows.size, bytes: mediaBytes, sha256: digestLines(imagePaths.map((path) => mediaRows.get(path)))},
        deferredDrain,
        worker: workerReport,
        sourceCatalog: {type: catalogType, adapter: archiveCatalog, totalEntries: catalogEntryCount},
        nativeParserUsed: result.debug?.phaseTimings?.some(({phase}) => phase.startsWith('term-file-fast-path:')) ?? false,
        staged: stagedBlob !== null,
    }
    process.stdout.write(JSON.stringify(report) + '\n')
}

await runImporter()
