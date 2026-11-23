import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {execFileSync} from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import {Worker as NodeWorker} from 'node:worker_threads'

const [root, prepared, output, expectedCommit] = process.argv.slice(2)
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const commit = () => execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim()
assert.equal(commit(), expectedCommit)
const manifestBytes = await fs.readFile(path.join(prepared, 'manifest.json'))
const manifest = JSON.parse(manifestBytes)
const lock = JSON.parse(await fs.readFile(path.join(root, 'test/perf/dictionaries.lock.json'), 'utf8')).dictionaries.jitendex
assert.equal(manifest.archiveSha256, lock.sha256)
assert.equal(manifest.rows, lock.termRows)
const sourcePaths = [
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/zstd-term-content.js',
    'ext/js/dictionary/zstd-term-content-compression-worker.js',
    'ext/js/dictionary/term-content-opfs-store.js',
    'ext/js/dictionary/term-content-block-envelope.js',
    'ext/js/dictionary/raw-term-content.js',
    'ext/js/dictionary/term-bank-experiments.js',
    'ext/lib/zstd-wasm.js',
    'ext/lib/zstd-simd-module.js',
    'ext/lib/zstd.wasm',
    'ext/lib/zstd-dicts/jmdict.zdict',
    'test/perf/dictionaries.lock.json',
]
const sourceHashes = Object.fromEntries(await Promise.all(sourcePaths.map(async (file) => [file, hash(await fs.readFile(path.join(root, file)))])))
const workers = []
const dispatch = {blocks: 0, logicalBytes: 0, backingBytes: 0}
class CompressionWorker {
    constructor(url) {
        this.listeners = new Map()
        this.worker = new NodeWorker(new URL('./node-compression-worker.mjs', import.meta.url), {workerData: {url: url.href}})
        this.ready = new Promise((resolve, reject) => {
            this.worker.on('message', (data) => {
                this.emit('message', {data})
                if (data.type === 'ready') resolve()
            })
            this.worker.on('error', (error) => {
                this.emit('error', {message: error.message})
                reject(error)
            })
        })
        this.worker.on('messageerror', () => this.emit('messageerror', {}))
        workers.push(this)
    }
    addEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener)) }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }
    emit(type, event) { for (const listener of this.listeners.get(type) ?? []) listener(event) }
    postMessage(message, transfer = []) {
        if (message.content instanceof Uint8Array) {
            assert.equal(transfer.includes(message.content.buffer), true)
            dispatch.blocks++
            dispatch.logicalBytes += message.content.byteLength
            dispatch.backingBytes += message.content.buffer.byteLength
        }
        this.worker.postMessage(message, transfer)
    }
    terminate() { return this.worker.terminate() }
}
globalThis.Worker = CompressionWorker
globalThis.fetch = async (input) => {
    const url = new URL(String(input), pathToFileURL(path.join(root, 'ext/')))
    assert.equal(url.protocol, 'file:')
    return new Response(await fs.readFile(url), {headers: {'Content-Type': 'application/wasm'}})
}
const moduleAt = (file) => import(pathToFileURL(path.join(root, file)))
const {TermContentBlockStore} = await moduleAt(sourcePaths[0])
const {TermContentOpfsStore} = await moduleAt(sourcePaths[3])
const {wrapCompressedTermContentBlock, TERM_CONTENT_BLOCK_ENVELOPE_BYTES} = await moduleAt(sourcePaths[4])
const {decodeRawTermContentCompactBlockReference, RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES: referenceBytes} = await moduleAt(sourcePaths[5])
const codec = await moduleAt(sourcePaths[1])
const compressionDictName = codec.resolveTermContentZstdDictName(lock.expectedTitle)
assert.equal(compressionDictName, 'jmdict')
assert.match(await fs.readFile(path.join(root, sourcePaths[1]), 'utf8'), /const JMDICT_COMPRESSION_LEVEL = -1;/)
assert.match(await fs.readFile(path.join(root, 'ext/js/dictionary/dictionary-database.js'), 'utf8'), /const TERM_CONTENT_BLOCK_TARGET_BYTES = 1024 \* 1024;/)
const content = new TermContentOpfsStore()
const blocks = new TermContentBlockStore(content, {blockTargetBytes: 1024 * 1024})
const session = blocks.beginImportSession()
const decodedHash = createHash('sha256')
const persistedHash = createHash('sha256')
const reports = []
let activeGroup = null
let lazyBatchCalls = 0
let verifiedContents = 0
let verifiedBytes = 0
let verifiedFrames = 0
const lazy = codec.TermContentCompressionPool.prototype.compressWrappedBlocks
if (lazy) codec.TermContentCompressionPool.prototype.compressWrappedBlocks = function (...args) {
    lazyBatchCalls++
    return lazy.apply(this, args)
}
const originalAppend = blocks._appendCompressedBlocks
blocks._appendCompressedBlocks = async function (packed, packedLengths, sourceLengths, dictName, force, frames, ...rest) {
    assert(activeGroup)
    const {source, offsets, report} = activeGroup
    assert.equal(sourceLengths.length, offsets.length)
    assert.equal(packed.blockStartIndexes.length, frames.length + 1)
    assert.equal(packed.blockStartIndexes[0], 0)
    assert.equal(packed.blockStartIndexes.at(-1), sourceLengths.length)
    report.blockStartIndexes = [...packed.blockStartIndexes]
    report.packedLengths = [...packedLengths]
    report.frames = []
    for (let blockIndex = 0; blockIndex < frames.length; blockIndex++) {
        const frame = frames[blockIndex]
        assert.deepEqual(wrapCompressedTermContentBlock(frame.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES)), frame)
        const decoded = codec.decompressTermContentZstd(frame.subarray(TERM_CONTENT_BLOCK_ENVELOPE_BYTES), dictName, {
            defaultHeapSize: packedLengths[blockIndex], maxOutputSize: packedLengths[blockIndex],
        })
        assert.equal(decoded.byteLength, packedLengths[blockIndex])
        let offset = 0
        for (let index = packed.blockStartIndexes[blockIndex]; index < packed.blockStartIndexes[blockIndex + 1]; index++) {
            const length = sourceLengths[index]
            const expected = source.subarray(offsets[index], offsets[index] + length)
            const actual = decoded.subarray(offset, offset + length)
            assert.equal(Buffer.compare(actual, expected), 0, `Decoded source mismatch at group ${report.index}, content ${index}`)
            offset += length
            verifiedContents++
            verifiedBytes += length
        }
        assert.equal(offset, decoded.byteLength)
        decodedHash.update(decoded)
        verifiedFrames++
        report.frames.push({bytes: frame.byteLength, sha256: hash(frame), decodedSha256: hash(decoded)})
    }
    return await originalAppend.call(this, packed, packedLengths, sourceLengths, dictName, force, frames, ...rest)
}
async function verifyGroup(group, index) {
    const buffers = {}
    for (const [kind, file] of Object.entries(group.files)) {
        const bytes = await fs.readFile(path.join(prepared, file))
        assert.equal(hash(bytes), group.hashes[kind], `Changed prepared ${file}`)
        buffers[kind] = bytes
    }
    const {source} = buffers
    const offsets = new Uint32Array(buffers.offsets.buffer, buffers.offsets.byteOffset, buffers.offsets.byteLength / 4)
    const lengths = new Uint32Array(buffers.lengths.buffer, buffers.lengths.byteOffset, buffers.lengths.byteLength / 4)
    assert.equal(source.byteLength, group.sourceBytes)
    assert.equal(lengths.length, group.selected)
    const report = {index, sourceBytes: source.byteLength, selectedContents: lengths.length}
    activeGroup = {source, offsets, report}
    const start = content._length
    const result = await session.appendSpans(lock.expectedTitle, source, offsets, lengths, compressionDictName)
    assert(result)
    assert.equal(result.contentOffsets.length, lengths.length)
    assert.deepEqual(result.contentLengths, lengths)
    const references = await content.readSlice(result.contentOffsets[0], lengths.length * referenceBytes)
    assert(references)
    let blockOffset = start
    for (let blockIndex = 0; blockIndex < report.frames.length; blockIndex++) {
        let entryOffset = 0
        for (let entry = report.blockStartIndexes[blockIndex]; entry < report.blockStartIndexes[blockIndex + 1]; entry++) {
            assert.equal(result.contentOffsets[entry], result.contentOffsets[0] + entry * referenceBytes)
            const actual = decodeRawTermContentCompactBlockReference(references.subarray(entry * referenceBytes, (entry + 1) * referenceBytes), lengths[entry])
            assert.deepEqual(actual, {
                blockOffset, blockCompressedLength: report.frames[blockIndex].bytes,
                blockUncompressedLength: report.packedLengths[blockIndex], entryOffset, entryLength: lengths[entry],
            })
            entryOffset += lengths[entry]
        }
        blockOffset += report.frames[blockIndex].bytes
    }
    assert.equal(result.contentOffsets[0], blockOffset)
    const persisted = await content.readSlice(start, content._length - start)
    assert(persisted)
    persistedHash.update(persisted)
    report.persistedBytes = persisted.byteLength
    report.persistedSha256 = hash(persisted)
    report.referenceSha256 = hash(references)
    report.contentOffsetsSha256 = hash(new Uint8Array(result.contentOffsets.buffer))
    report.contentDictName = result.contentDictName
    reports.push(report)
    activeGroup = null
    console.log(JSON.stringify({verifiedGroup: index, selectedContents: lengths.length, frames: report.frames.length}))
}
try {
    await codec.initializeTermContentZstd()
    await Promise.all(workers.map((worker) => worker.ready))
    await new Promise(setImmediate)
    for (let index = 0; index < manifest.groups.length; index++) {
        await verifyGroup(manifest.groups[index], index)
        globalThis.gc?.()
    }
    assert.equal(verifiedContents, manifest.selectedContents)
    assert.equal(verifiedBytes, manifest.selectedBytes)
    assert.equal(dispatch.blocks, verifiedFrames)
    assert.equal(dispatch.logicalBytes, verifiedBytes)
    assert.equal(dispatch.backingBytes, verifiedBytes)
    assert.equal(lazyBatchCalls, lazy ? manifest.groups.length : 0)
    assert.equal(commit(), expectedCommit)
    for (const file of sourcePaths) assert.equal(hash(await fs.readFile(path.join(root, file))), sourceHashes[file], `Source changed: ${file}`)
    const report = {
        scope: 'Untimed whole prepared Jitendex unique-content corpus; exact production block store and four Node worker entry points. Fixed parser-derived groups, not browser whole-import evidence.',
        sourceCommit: expectedCommit, sourceRoot: root, sourceHashes, node: process.version,
        runnerSha256: hash(await fs.readFile(new URL(import.meta.url))),
        bridgeSha256: hash(await fs.readFile(new URL('./node-compression-worker.mjs', import.meta.url))),
        archiveSha256: manifest.archiveSha256, manifestSha256: hash(manifestBytes), manifestInputDigest: manifest.inputDigest,
        sourceRows: manifest.rows, sourceJsonBytes: manifest.sourceJsonBytes,
        verifiedContents, verifiedBytes, verifiedFrames, verifiedReferences: verifiedContents,
        decodedContentSha256: decodedHash.digest('hex'), persistedBytes: content._length,
        persistedSha256: persistedHash.digest('hex'), compressionDictName, compressionLevel: -1,
        blockTargetBytes: 1024 * 1024, workers: workers.length, lazyBatchCalls, dispatch,
        retainedInputGroups: 1, largestSourceGroupBytes: Math.max(...manifest.groups.map((group) => group.sourceBytes)),
        groups: reports,
    }
    await fs.writeFile(output, `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify({result: 'passed', output, verifiedContents, verifiedFrames, persistedSha256: report.persistedSha256}))
} finally {
    session.close()
    await Promise.all(workers.map((worker) => worker.terminate()))
}
