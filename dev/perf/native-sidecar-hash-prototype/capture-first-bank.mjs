/* SPDX-License-Identifier: GPL-3.0-or-later */

import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'

const [rootPath, cachePath, destinationPath, ...requested] = process.argv.slice(2)
assert(rootPath && cachePath && destinationPath)
const root = resolve(rootPath)
const destination = resolve(destinationPath)
const allGroups = requested.includes('--all-groups')
const groupMode = allGroups || requested.includes('--group')
const selected = requested.filter((value) => value !== '--group' && value !== '--all-groups')
const dictionaries = selected.length > 0 ? selected : ['jmdict', 'jitendex', 'vndb']
const require = createRequire(join(root, 'package.json'))
const {BlobReader, Uint8ArrayWriter, ZipReader} = await import(require.resolve('@zip.js/zip.js'))
const localImport = (filename) => import(pathToFileURL(join(root, filename)))
const parser = await localImport('ext/js/dictionary/term-bank-wasm-parser.js')
const parserSource = await readFile(join(root, 'ext/js/dictionary/term-bank-wasm-parser.js'), 'utf8')
const records = await localImport('ext/js/dictionary/term-record-opfs-store.js')
const {splitPersistedTermLookupIndex} = await localImport('ext/js/dictionary/term-lookup-index.js')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const locks = await readFile(join(root, 'test/perf/dictionaries.lock.json'))
const fixtures = JSON.parse(locks).dictionaries
const wasmBytes = await readFile(join(root, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
await mkdir(destination, {recursive: true})
const report = {lockSha256: sha256(locks), parserWasmSha256: sha256(wasmBytes), dictionaries: []}
report.scope = groupMode ? `${allGroups ? 'All' : 'First'} current-policy partitions, parsed synchronously; production source partition functions extracted verbatim; deterministic content references; not worker scheduling or persistence replay` : 'First term bank, parsed synchronously; deterministic content references'
report.parserSourceSha256 = sha256(parserSource)
Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {hardwareConcurrency: 4, deviceMemory: 8}})

// Use the source's real partition functions without modifying runtime exports.
// This is bounded fixture construction, not a replacement import policy.
function extractFunction(name) {
    const start = parserSource.indexOf(`function ${name}(`)
    assert(start >= 0)
    const end = parserSource.indexOf('\n}', start)
    assert(end > start)
    return parserSource.slice(start, end + 2)
}
const partitionSource = extractFunction('partitionSourceBanks') + '\n' + extractFunction('getPartitionSourceByteLength')
const partition = runInNewContext(partitionSource + '\npartitionSourceBanks')
const groupCountSource = extractFunction('getParallelSourcePipelineGroupsPerWorker')
const groupsPerWorker = runInNewContext(groupCountSource + '\ngetParallelSourcePipelineGroupsPerWorker', {
    MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER: Number(parserSource.match(/const MEDIA_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = (\d+);/)[1]),
    PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER: Number(parserSource.match(/const PLAIN_PARALLEL_SOURCE_PIPELINE_GROUPS_PER_WORKER = (\d+);/)[1]),
})
const targetGroupBytes = runInNewContext(parserSource.match(/const LAZY_PARALLEL_SOURCE_TARGET_GROUP_BYTES = ([^;]+);/)[1])

for (const dictionary of dictionaries) {
    const fixture = fixtures[dictionary]
    assert(fixture)
    const archivePath = join(cachePath, fixture.cacheFile)
    const archiveHash = createHash('sha256')
    for await (const bytes of createReadStream(archivePath)) archiveHash.update(bytes)
    assert.equal(archiveHash.digest('hex'), fixture.sha256)
    const archive = await openAsBlob(archivePath)
    assert.equal(archive.size, fixture.sizeBytes)
    const zip = new ZipReader(new BlobReader(archive))
    try {
        const entries = await zip.getEntries()
        const termFiles = entries.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename))
            .sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
        const bank = termFiles[0]
        assert(bank)
        let selectedGroups = [[bank]]
        let partitionCount = 1
        if (groupMode) {
            const totalBytes = termFiles.reduce((sum, file) => sum + file.uncompressedSize, 0)
            const requestedCount = Math.max(parser.getParallelTermBankParserWorkerCount() *
                groupsPerWorker({mediaHintFastScan: fixture.mediaFiles > 0}), Math.ceil(totalBytes / targetGroupBytes))
            const groups = partition(termFiles.map((file) => ({file, estimatedBytes: file.uncompressedSize})), totalBytes, requestedCount)
            selectedGroups = (allGroups ? groups : groups.slice(0, 1)).map((group) => group.map(({file}) => file))
            partitionCount = groups.length
        }
        let dictionaryRows = 0
        for (const [groupIndex, selectedFiles] of selectedGroups.entries()) {
            const sources = []
            for (const file of selectedFiles) sources.push(await file.getData(new Uint8ArrayWriter(), {useWebWorkers: false, checkSignature: true}))
            let chunk
            await parser.parseTermBankWithWasmColumnChunks(sources, 3, (value) => {
                assert.equal(chunk, undefined)
                chunk = parser.copyWasmBackedColumnChunk(value)
            }, 2048, {
                emitContentSlab: true, emitTokenBinaryContent: true, emitTermByteLists: false,
                prepareLookupIndexes: true, singleChunk: true, computeContentHashes: true,
                validateGlossaryTypes: true, mediaHintFastScan: fixture.mediaFiles > 0,
            })
            assert(chunk?.rowCount > 0)
            const plan = chunk.contentDedupPlan
            assert(plan && chunk.contentUniqueIndexList && chunk.contentMetaList)
            const offsets = new Float64Array(plan.uniqueCount)
            const lengths = new Uint32Array(plan.uniqueCount)
            for (let i = 0; i < plan.uniqueCount; i++) {
                const index = (chunk.contentMetaByUniqueIndex ? i : plan.uniqueRowIndexes[i]) * 4
                offsets[i] = 2 ** 40 + chunk.contentMetaList[index]
                lengths[i] = chunk.contentMetaList[index + 1]
            }
            const recordChunk = records.createArtifactTermRecordChunkWithResolvedContent(
                {...chunk, dictionary: fixture.expectedTitle}, chunk.contentUniqueIndexList,
                offsets, lengths, chunk.preparedLookupIndexes)
            const store = new records.TermRecordOpfsStore()
            const writes = []
            store._appendEncodedChunk = async (...args) => { writes.push(args) }
            await store._encodeAndAppendArtifactChunkForState({}, recordChunk, 1,
                new Float64Array(0), new Uint32Array(0), chunk.termRecordPreinternedPlan,
                'raw', chunk.preparedLookupIndexes)
            const result = {dictionary, groupIndex, archiveSha256: fixture.sha256, bank: selectedFiles.map((file) => file.filename).join(','),
                partitionCount, hardwareConcurrency: 4, deviceMemory: 8,
                bankBytes: sources.reduce((sum, source) => sum + source.byteLength, 0),
                bankSha256: sha256(Buffer.concat(sources)), rows: chunk.rowCount, inputs: []}
            for (let i = 0; i < writes.length; i++) {
                const args = writes[i]
                const {base, derived} = splitPersistedTermLookupIndex(args[5])
                // Exercise the production checksum reader and authoritative record
                // validation before saving only the three independently hashed spans.
                const sidecar = store._createLookupIndexChunk(args[1], args[2], args[4], args[5], args[6], args[7])
                const header = new DataView(sidecar.buffer, sidecar.byteOffset, sidecar.byteLength)
                for (const [section, bytes, hashOffset] of [['base', base, 24], ['derived', derived, 28], ['records', args[6], 32]]) {
                    const filename = `${dictionary}-${groupIndex}-${i}-${section}.bin`
                    await writeFile(join(destination, filename), bytes, {flag: 'wx'})
                    result.inputs.push({filename, section, bytes: bytes.byteLength,
                        sha256: sha256(bytes), xxh32: header.getUint32(hashOffset, true)})
                }
            }
            dictionaryRows += chunk.rowCount
            report.dictionaries.push(result)
            console.log(JSON.stringify(result))
        }
        if (allGroups) assert.equal(dictionaryRows, fixture.termRows)
    } finally {
        await zip.close()
    }
}
await writeFile(join(destination, 'manifest.json'), JSON.stringify(report, null, 2) + '\n', {flag: 'wx'})
