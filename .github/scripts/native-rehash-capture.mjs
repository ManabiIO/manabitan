import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {createReadStream, openAsBlob} from 'node:fs'
import {mkdir, readFile, writeFile} from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {crc32, inflateRawSync} from 'node:zlib'

const [baseline, candidate, dictionary, archivePath, outputDirectory] = process.argv.slice(2)
assert(baseline && candidate && ['jmdict', 'jitendex', 'vndb'].includes(dictionary) && archivePath && outputDirectory)
await mkdir(outputDirectory, {recursive: true})
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const importFrom = (root, file) => import(pathToFileURL(path.join(root, file)))
const fixture = JSON.parse(await readFile(path.join(baseline, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries[dictionary]
const archiveHash = createHash('sha256')
for await (const bytes of createReadStream(archivePath)) { archiveHash.update(bytes) }
assert.equal(archiveHash.digest('hex'), fixture.sha256)
const archive = await openAsBlob(archivePath)
assert.equal(archive.size, fixture.sizeBytes)
const {readDenseZipDirectory} = await importFrom(baseline, 'ext/js/dictionary/dense-zip-directory.js')
const {RawZipPayloadReader} = await importFrom(baseline, 'ext/js/dictionary/term-bank-source-pipeline.js')
const parser = await importFrom(baseline, 'ext/js/dictionary/term-bank-wasm-parser.js')
parser.setTermBankWasmModule(await WebAssembly.compile(await readFile(path.join(baseline, 'dev/data/dictionary-wasm/term-bank-parser.wasm'))))
let directory = await readDenseZipDirectory(archive)
if (directory === null) {
    const {BlobReader, ZipReader} = await importFrom(baseline, 'ext/lib/zip.js')
    const reader = new ZipReader(new BlobReader(archive))
    directory = await reader.getEntries()
    await reader.close()
}
const banks = directory.filter(({filename}) => /^term_bank_\d+\.json$/.test(filename)).sort((a, b) => Number(a.filename.slice(10, -5)) - Number(b.filename.slice(10, -5)))
const totalBytes = banks.reduce((sum, bank) => sum + bank.uncompressedSize, 0)
const groupCount = Math.min(banks.length, Math.max(dictionary === 'jmdict' ? 12 : 9, Math.ceil(totalBytes / (24 * 1024 * 1024))))
const groups = []
let start = 0
let consumedBytes = 0
for (let group = 0; group < groupCount - 1; ++group) {
    const remaining = groupCount - group
    const target = (totalBytes - consumedBytes) / remaining
    let end = start + 1
    let bytes = banks[start].uncompressedSize
    while (end < banks.length - (remaining - 1)) {
        const next = bytes + banks[end].uncompressedSize
        if (Math.abs(next - target) > Math.abs(bytes - target)) { break }
        bytes = next
        ++end
    }
    groups.push(banks.slice(start, end))
    start = end
    consumedBytes += bytes
}
groups.push(banks.slice(start))

const arenaNames = ['slots', 'hash1', 'hash2', 'state', 'length', 'signaturePresent', 'signature1', 'signature2', 'signature3']
const sideNames = ['_termEntryContentMetaIdTable', '_termEntryContentMetaOffsetTable', '_termEntryContentMetaDictNameIdTable', '_termEntryContentMetaRecentSourceBatchIdTable', '_termEntryContentMetaRecentSourceOffsetTable']
const databases = {}
const sourceSlabs = []
const sourceStarts = []
const capture = {dictionary, fixture, node: process.version,
    scope: 'Native production parser groups and reservation formula, with synchronous publication after each complete canonical scan. This records exact replay capacity sequences; live asynchronous browser growth/pending sequences are not inferred from trace samples.',
    groupCount, sourceBytes: totalBytes, groups: [], replacements: [], snapshots: [], complete: false}
const digests = {A: createHash('sha256'), B: createHash('sha256')}
const hashView = (hash, view) => hash.update(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))
let groupIndex = -1
let snapshotsBytes = 0
for (const [arm, root] of [['A', baseline], ['B', candidate]]) {
    const {DictionaryDatabase} = await importFrom(root, 'ext/js/dictionary/dictionary-database.js')
    const {NativeCanonicalScanner} = await importFrom(root, 'ext/js/dictionary/term-content-canonical-scan.js')
    const kernelBytes = await readFile(path.join(root, 'dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm'))
    const kernel = await WebAssembly.compile(kernelBytes)
    const db = new DictionaryDatabase()
    db._nativeCanonicalScanner = new NativeCanonicalScanner({loadModule: async () => kernel})
    db._readTermEntryContentMetaHashPairIndex = (index) => {
        const arena = db._termContentMetadataArena
        assert.equal(arena.state[index], 1)
        return {id: 0, offset: db._termEntryContentMetaOffsetTable[index], length: arena.length[index], dictName: 'raw-v6', tableIndex: index,
            signature1: arena.signature1[index], signature2: arena.signature2[index], signature3: arena.signature3[index]}
    }
    const resize = db._resizeTermContentMetadataArena.bind(db)
    db._resizeTermContentMetadataArena = (requiredCount, slotCapacity, forceRehash = false) => {
        const old = db._termContentMetadataArena
        const denseCount = db._termEntryContentMetaDenseCount
        const replaces = forceRehash || (old?.state.length ?? 0) < requiredCount || (old?.slots.length ?? 0) !== slotCapacity
        if (replaces) {
            const row = {arm, groupIndex, requiredCount, slotCapacity, forceRehash, denseCount,
                oldDenseCapacity: old?.state.length ?? 0, oldSlotCapacity: old?.slots.length ?? 0,
                publishedCount: db._termEntryContentMetaHashPairCount, pendingCount: db._termEntryContentMetaHashPairPendingCount,
                nativeModuleAlreadyLoaded: db._nativeCanonicalScanner.stats.calls > 0}
            capture.replacements.push(row)
            if (arm === 'A' && old !== null && denseCount > 0 && (forceRehash || old.slots.length !== slotCapacity)) {
                const columns = [...arenaNames.map((name) => ({name, value: old[name], kind: 'arena'})), ...sideNames.map((name) => ({name, value: db[name], kind: 'side'}))]
                const data = Buffer.concat(columns.map(({value}) => Buffer.from(value.buffer, value.byteOffset, value.byteLength)))
                snapshotsBytes += data.length
                assert(snapshotsBytes <= 64 * 1024 * 1024, 'Bounded snapshot budget exceeded')
                const file = `${dictionary}-resize-${capture.snapshots.length}.bin`
                const descriptor = {...row, file, sha256: sha256(data), byteLength: data.length, columns: []}
                let offset = 0
                for (const {name, value, kind} of columns) {
                    descriptor.columns.push({name, kind, type: value.constructor.name, offset, length: value.length, byteLength: value.byteLength})
                    offset += value.byteLength
                }
                capture.snapshots.push(descriptor)
                // Snapshot writes are intentionally outside every timed screen.
                capture.pendingWrites.push(writeFile(path.join(outputDirectory, file), data))
            }
        }
        resize(requiredCount, slotCapacity, forceRehash)
    }
    databases[arm] = db
    capture[`${arm}KernelSha256`] = sha256(kernelBytes)
}
capture.pendingWrites = []
const options = {
    experimentalNativeEscapedKeys: dictionary === 'vndb', singleChunk: true, maxPendingChunks: 1,
    emitTermByteLists: false, computeContentHashes: true, emitContentSlab: true, emitTokenBinaryContent: true,
    compactContentMetadata: true, mediaHintFastScan: dictionary !== 'jmdict', projectImagePaths: dictionary === 'vndb',
    validateGlossaryTypes: true, prepareLookupIndexes: true,
}
capture.parserOptions = options
const reader = new RawZipPayloadReader(archive)
let totalRows = 0
let totalUnique = 0
let contentBytes = 0
let estimatedTotalRows = 0
for (groupIndex = 0; groupIndex < groups.length; ++groupIndex) {
    const group = groups[groupIndex]
    const sources = await Promise.all(group.map(async (entry) => ({...entry, bytes: await reader.read(entry, new AbortController().signal, true)})))
    for (const source of sources) {
        const bytes = source.compressionMethod === 0 ? source.bytes : inflateRawSync(source.bytes)
        assert.equal(bytes.length, source.uncompressedSize)
        assert.equal(crc32(bytes), source.signature)
    }
    const preloadedSource = await parser.inflateCompressedTermBankSourcesWasm(sources, options, true)
    let chunk
    await parser.parseTermBankWithWasmColumnChunks(new Uint8Array(0), 3, (value) => {
        assert.equal(chunk, undefined)
        chunk = parser.copyWasmBackedColumnChunk(value, false, dictionary === 'vndb', false, preloadedSource)
    }, 2048, {...options, preloadedSource})
    assert(chunk)
    const nativePlan = chunk.contentDedupPlan
    assert(nativePlan && nativePlan.uniqueSignatures instanceof Uint32Array)
    const groupBytes = group.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
    if (groupIndex === 0) { estimatedTotalRows = Math.max(chunk.rowCount, Math.round(chunk.rowCount * totalBytes / groupBytes)) }
    totalRows += chunk.rowCount
    totalUnique += nativePlan.uniqueCount
    chunk.dictionaryTotalRows = groupIndex + 1 === groups.length ? totalRows : Math.max(totalRows, estimatedTotalRows)
    const row = {groupIndex, banks: group.map(({filename}) => filename), sourceBytes: groupBytes, rows: chunk.rowCount,
        uniqueCount: nativePlan.uniqueCount, estimatedTotalRows: chunk.dictionaryTotalRows, contentBytes: chunk.contentBytesLength,
        compactMetadata: chunk.contentMetaByUniqueIndex === true}
    for (const arm of ['A', 'B']) {
        const db = databases[arm]
        const hint = db._getArtifactTermContentMetaCapacityHint(chunk, nativePlan.uniqueCount)
        db._ensureTermEntryContentMetaHashPairCapacity(hint)
        const columns = Array.from({length: 6}, () => new Uint32Array(nativePlan.uniqueCount))
        const plan = {resolvedFlags: new Uint8Array(nativePlan.uniqueCount), pendingEpochs: null, pendingIndexes: null}
        const exactCandidates = []
        let pendingCount = 0
        let exactCount = 0
        await db._nativeCanonicalScanner.scan(db, {
            chunk: {...chunk, contentDictNameList: null, uniformContentDictName: 'raw-v6'},
            contentDedupPlan: plan,
            uniqueIndexList: chunk.contentUniqueIndexList,
            uniqueRowIndexes: nativePlan.uniqueRowIndexes,
            uniqueSignatures: nativePlan.uniqueSignatures,
            firstUniqueIndex: 0, lastUniqueIndex: nativePlan.uniqueCount,
            persistedLookupRequired: true, reserveMetadata: true,
            adoptPendingColumns(batch, complete) {
                for (let i = 0; i < columns.length; ++i) { columns[i].set(batch.columns[i], pendingCount) }
                pendingCount += batch.columns[0].length
                complete()
            },
            getPendingCount: () => pendingCount,
            exactCandidates,
            async resolveExactCandidates() {
                for (const item of exactCandidates) {
                    const meta = item.existingMeta
                    let previous = sourceStarts.length - 1
                    while (sourceStarts[previous] > meta.offset) { --previous }
                    assert(previous >= 0)
                    const source = sourceSlabs[previous]
                    const local = meta.offset - sourceStarts[previous]
                    assert.equal(meta.length, item.contentLength)
                    assert(Buffer.from(source.buffer, source.byteOffset + local, meta.length).equals(Buffer.from(chunk.contentBytesBuffer.buffer, chunk.contentBytesBuffer.byteOffset + item.contentOffset, item.contentLength)))
                    plan.resolvedFlags[item.uniqueIndex] = 1
                    ++exactCount
                }
                exactCandidates.length = 0
            },
        }, {})
        assert.equal(db._nativeCanonicalScanner.stats.fallbacks, 0)
        assert.equal(pendingCount + exactCount, nativePlan.uniqueCount)
        const arena = db._termContentMetadataArena
        for (let i = 0; i < pendingCount; ++i) {
            const index = columns[5][i]
            assert.equal(index, db._termEntryContentMetaHashPairCount + i)
            assert.equal(arena.state[index], 2)
            db._termEntryContentMetaOffsetTable[index] = contentBytes + columns[0][i] - chunk.contentBytesBaseOffset
            arena.state[index] = 1
        }
        db._termEntryContentMetaHashPairPendingCount -= pendingCount
        db._termEntryContentMetaHashPairCount += pendingCount
        for (const column of columns) { hashView(digests[arm], column.subarray(0, pendingCount)) }
        row[arm] = {hint, pendingCount, exactCount, denseCount: db._termEntryContentMetaDenseCount,
            denseCapacity: arena.state.length, slotCapacity: arena.slots.length}
    }
    assert.deepEqual(row.B, row.A)
    for (const name of arenaNames) { assert.deepEqual(databases.B._termContentMetadataArena[name], databases.A._termContentMetadataArena[name]) }
    for (const name of sideNames) { assert.deepEqual(databases.B[name], databases.A[name]) }
    sourceSlabs.push(chunk.contentBytesBuffer.subarray(chunk.contentBytesBaseOffset, chunk.contentBytesBaseOffset + chunk.contentBytesLength))
    sourceStarts.push(contentBytes)
    contentBytes += chunk.contentBytesLength
    capture.groups.push(row)
    if (groupIndex % 10 === 0) { process.stdout.write(`${dictionary} canonical parity ${groupIndex + 1}/${groups.length}\n`) }
}
const expected = {
    jmdict: {rows: 528299, unique: 366030, published: 362032, exact: 3998, calls: 12},
    jitendex: {rows: 436555, unique: 363277, published: 363243, exact: 34, calls: 22},
    vndb: {rows: 6648310, unique: 157864, published: 157150, exact: 714, calls: 170},
}[dictionary]
assert.equal(totalRows, expected.rows)
assert.equal(totalUnique, expected.unique)
for (const arm of ['A', 'B']) {
    const db = databases[arm]
    assert.equal(db._termEntryContentMetaHashPairCount, expected.published)
    assert.equal(db._nativeCanonicalScanner.stats.exactDescriptorRows, expected.exact)
    assert.equal(db._nativeCanonicalScanner.stats.calls, expected.calls)
    for (const name of arenaNames) { hashView(digests[arm], db._termContentMetadataArena[name]) }
    for (const name of sideNames) { hashView(digests[arm], db[name]) }
    capture[`${arm}Digest`] = digests[arm].digest('hex')
    capture[`${arm}Stats`] = db._nativeCanonicalScanner.stats
}
assert.equal(capture.ADigest, capture.BDigest)
await Promise.all(capture.pendingWrites)
delete capture.pendingWrites
capture.complete = true
capture.totalRows = totalRows
capture.totalUnique = totalUnique
capture.contentBytes = contentBytes
capture.snapshotsBytes = snapshotsBytes
await writeFile(path.join(outputDirectory, `${dictionary}-capture.json`), `${JSON.stringify(capture, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({dictionary, complete: capture.complete, snapshots: capture.snapshots.map(({groupIndex, denseCount, oldDenseCapacity, oldSlotCapacity, slotCapacity}) => ({groupIndex, denseCount, oldDenseCapacity, oldSlotCapacity, slotCapacity})), snapshotsBytes, digest: capture.ADigest})}\n`)
