import assert from 'node:assert/strict'
import {createHash} from 'node:crypto'
import {readFile, writeFile} from 'node:fs/promises'
import {pathToFileURL} from 'node:url'
import path from 'node:path'

const [root, inputsPath, outputPath] = process.argv.slice(2)
assert(root && inputsPath && outputPath, 'Usage: node reserved-layout-witness.mjs REPO CRC_INPUTS OUTPUT')
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const importSource = (file) => import(pathToFileURL(path.join(root, file)).href)
const nativeFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
    const value = String(input)
    const resource = value.startsWith('/lib/') ? pathToFileURL(path.join(root, 'ext', value)) : new URL(value)
    if (resource.protocol !== 'file:') return await nativeFetch(input, init)
    return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}})
}
const parser = await importSource('ext/js/dictionary/term-bank-wasm-parser.js')
const {TermContentBlockStore} = await importSource('ext/js/dictionary/term-content-block-store.js')
const {TermContentOpfsStore} = await importSource('ext/js/dictionary/term-content-opfs-store.js')
const {initializeTermContentZstd, resolveTermContentZstdDictName} = await importSource('ext/js/dictionary/zstd-term-content.js')
const {decodeRawTermContentCompactBlockReference, RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES} = await importSource('ext/js/dictionary/raw-term-content.js')
const inputs = JSON.parse(await readFile(inputsPath, 'utf8'))
const wasmBytes = await readFile(path.join(root, 'ext/lib/term-bank-parser.wasm'))
assert.equal(sha256(wasmBytes), inputs.variants.baseline.productWasmSha256)
parser.setTermBankWasmModule(await WebAssembly.compile(wasmBytes))
await initializeTermContentZstd()
const dictionary = 'Jitendex'
const dictName = resolveTermContentZstdDictName(dictionary)
assert.equal(dictName, 'jmdict')
const ordinaryOpfs = new TermContentOpfsStore()
const reservedOpfs = new TermContentOpfsStore()
const ordinary = new TermContentBlockStore(ordinaryOpfs)
const reserved = new TermContentBlockStore(reservedOpfs)
const groups = []
const files = [
    'ext/js/dictionary/term-bank-wasm-parser.js',
    'ext/js/dictionary/term-content-block-store.js',
    'ext/js/dictionary/term-content-opfs-store.js',
    'ext/js/dictionary/zstd-term-content.js',
    'ext/js/dictionary/raw-term-content.js',
    'ext/lib/term-bank-parser.wasm',
    'ext/lib/zstd.wasm',
    'ext/lib/zstd-dicts/jmdict.zdict',
]
const sourceHashes = Object.fromEntries(await Promise.all(files.map(async (file) => [file, sha256(await readFile(path.join(root, file)))])))
const plan = {
    purpose: 'Correctness-only witness for reserved reference prefixes versus ordinary reference suffixes; not a benchmark or a replacement for browser content validation',
    root,
    archiveSha256: inputs.corpora.jitendex.archiveSha256,
    inputsSha256: sha256(await readFile(inputsPath)),
    harnessSha256: sha256(await readFile(process.argv[1])),
    sourceHashes,
    dictionary,
    dictName,
    globalWorkerType: typeof globalThis.Worker,
    parserOptions: {singleChunk: true, emitContentSlab: true, emitTokenBinaryContent: true, computeContentHashes: true, mediaHintFastScan: true, prepareLookupIndexes: false},
}
try {
    for (const bank of inputs.corpora.jitendex.banks) {
        const bytes = await readFile(bank.path)
        assert.equal(sha256(bytes), bank.sha256)
        let owned
        let shared
        await parser.parseTermBankWithWasmColumnChunks(bytes, 3, (chunk) => {
            assert.equal(owned, undefined, 'Expected exactly one native chunk per bank')
            owned = parser.copyWasmBackedColumnChunk(chunk, false, true)
            shared = parser.copyWasmBackedColumnChunk(chunk, true, true, true)
        }, 0, plan.parserOptions)
        assert(owned && shared)
        assert(owned.contentBytesBuffer.buffer instanceof ArrayBuffer)
        assert(shared.contentBytesBuffer.buffer instanceof SharedArrayBuffer)
        assert.deepEqual(owned.contentMetaList, shared.contentMetaList)
        assert.deepEqual(owned.contentBytesBuffer, shared.contentBytesBuffer)
        const spanKeys = new Set()
        const offsetValues = []
        const lengthValues = []
        const rowIndexes = []
        for (let i = 0; i < owned.rowCount; ++i) {
            const offset = owned.contentMetaList[i * 4]
            const length = owned.contentMetaList[i * 4 + 1]
            assert(length > 0)
            assert(offset + length <= owned.contentBytesBuffer.length)
            const key = `${offset}:${length}`
            if (spanKeys.has(key)) continue
            spanKeys.add(key)
            offsetValues.push(offset)
            lengthValues.push(length)
            rowIndexes.push(i)
        }
        const offsets = Uint32Array.from(offsetValues)
        const lengths = Uint32Array.from(lengthValues)
        const expected = offsetValues.map((offset, i) => owned.contentBytesBuffer.slice(offset, offset + lengthValues[i]))
        const sourceStart = Reflect.get(ordinaryOpfs, '_length')
        assert.equal(Reflect.get(reservedOpfs, '_length'), sourceStart)
        const a = await ordinary.tryAppendSpans(owned.contentBytesBuffer, offsets, lengths, dictName)
        assert(a, 'Ordinary packed storage should be selected for this real bank')
        const operation = reserved.tryBeginAppendSpans(shared.contentBytesBuffer, offsets, lengths, dictName)
        assert(operation, 'Real bank should pass the default initial shared reservation admission')
        const reservedStorage = await operation.storage
        await operation.sourceConsumed
        const b = await operation.completion
        assert.deepEqual(b.contentOffsets, reservedStorage.contentOffsets)
        assert.equal(b.initialSelectionSavingsMiss, false)
        assert.equal(a.compressedBytes, b.compressedBytes)
        assert.equal(a.uncompressedBytes, b.uncompressedBytes)
        assert.equal(a.contentDictName, b.contentDictName)
        assert.deepEqual(a.contentLengths, b.contentLengths)
        const referenceBytes = lengths.length * RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES
        const sourceEnd = Reflect.get(ordinaryOpfs, '_length')
        assert.equal(Reflect.get(reservedOpfs, '_length'), sourceEnd)
        assert.equal(sourceEnd - sourceStart, a.compressedBytes + referenceBytes)
        const blocks = new Map()
        const references = []
        for (let i = 0; i < lengths.length; ++i) {
            assert.equal(a.contentOffsets[i] - b.contentOffsets[i], a.compressedBytes)
            const ra = decodeRawTermContentCompactBlockReference(await ordinaryOpfs.readSlice(a.contentOffsets[i], RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES), lengths[i])
            const rb = decodeRawTermContentCompactBlockReference(await reservedOpfs.readSlice(b.contentOffsets[i], RAW_TERM_CONTENT_COMPACT_BLOCK_REFERENCE_BYTES), lengths[i])
            assert(ra && rb)
            assert.equal(rb.blockOffset - ra.blockOffset, referenceBytes)
            assert.deepEqual({...ra, blockOffset: 0}, {...rb, blockOffset: 0})
            if (!blocks.has(ra.blockOffset)) {
                const blockA = await ordinaryOpfs.readSlice(ra.blockOffset, ra.blockCompressedLength)
                const blockB = await reservedOpfs.readSlice(rb.blockOffset, rb.blockCompressedLength)
                assert.deepEqual(blockA, blockB)
                blocks.set(ra.blockOffset, {ordinaryOffset: ra.blockOffset, reservedOffset: rb.blockOffset, bytes: blockA.length, sha256: sha256(blockA)})
            }
            references.push({rowIndex: rowIndexes[i], ordinaryReferenceOffset: a.contentOffsets[i], reservedReferenceOffset: b.contentOffsets[i], length: lengths[i], expectedSha256: sha256(expected[i]), ordinary: ra, reserved: rb})
        }
        owned.contentBytesBuffer.fill(0)
        shared.contentBytesBuffer.fill(255)
        ordinary.clearCache()
        reserved.clearCache()
        for (const [label, store, stored] of [['ordinary', ordinary, a], ['reserved', reserved, b]]) {
            const results = await store.readDetailedBatch(Array.from(stored.contentOffsets, (contentOffset, i) => ({contentOffset, contentLength: stored.contentLengths[i], contentDictName: stored.contentDictName})))
            for (let i = 0; i < results.length; ++i) {
                assert.equal(results[i].status, 'ok', `${label} row ${i}`)
                assert.deepEqual(results[i].bytes, expected[i], `${label} full content row ${i}`)
            }
        }
        groups.push({bank: bank.name, bankSha256: bank.sha256, rowCount: owned.rowCount, uniqueSpanCount: lengths.length, sourceStart, sourceEnd, compressedBytes: a.compressedBytes, uncompressedBytes: a.uncompressedBytes, referenceBytes, contentDictName: a.contentDictName, ordinaryReferenceStart: a.contentOffsets[0], reservedReferenceStart: b.contentOffsets[0], blocks: [...blocks.values()], references, fullDecodedBytesVerified: true})
    }
    const receipt = {status: 'success', plan, groups, conclusion: 'On these pinned real term banks, only the physical ordering/offsets differ: compressed block bytes and every decoded content span are identical after source overwrite and cache invalidation. This does not by itself prove the hosted browser probe mismatch is offset-only.'}
    await writeFile(outputPath, JSON.stringify(receipt, null, 2) + '\n', {flag: 'wx'})
    console.log(JSON.stringify({status: receipt.status, groups: groups.map(({references, ...group}) => group), conclusion: receipt.conclusion}, null, 2))
} catch (error) {
    await writeFile(outputPath, JSON.stringify({status: 'failed', plan, groups, error: String(error)}, null, 2) + '\n', {flag: 'wx'})
    throw error
} finally {
    globalThis.fetch = nativeFetch
}
