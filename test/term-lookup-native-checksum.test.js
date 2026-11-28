/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */
/* eslint-disable-next-line @typescript-eslint/ban-ts-comment */
// @ts-nocheck
/* eslint-disable no-extend-native -- Admission fault tests restore intrinsics synchronously in finally. */
/* eslint-disable unicorn/prefer-spread -- Typed copies preserve byte ownership and canary contents. */

import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {test, vi} from 'vitest'
import {CANONICAL_CHECKSUM_LAYOUT as checksumLayout, CANONICAL_SCAN_LAYOUT as layout} from '../ext/js/dictionary/term-content-canonical-layout.js'
import {NativeCanonicalScanner} from '../ext/js/dictionary/term-content-canonical-scan.js'
import {TermContentMetadataArena} from '../ext/js/dictionary/term-content-metadata-arena.js'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'
import {TermRecordOpfsStore} from '../ext/js/dictionary/term-record-opfs-store.js'

const wasmBytes = await readFile(new URL('../dev/data/dictionary-wasm/term-content-canonical-scan-v1.wasm', import.meta.url))
const module = await WebAssembly.compile(wasmBytes)
const bytes = (length, offset = 0) => {
    const output = new Uint8Array(new ArrayBuffer(length + offset + 5), offset, length)
    for (let i = 0; i < length; ++i) { output[i] = ((i * 131) ^ ((i >>> 7) * 17) ^ length) & 255 }
    return output
}
const inputs = () => [bytes(65537, 3), bytes(20481, 5), bytes(4097, 11)]
const expected = (source) => source.map((value) => hashTermKeyBytes(value))

function fixture({loadModule = async () => module, hooks = {}} = {}) {
    const arena = new TermContentMetadataArena(32, 64)
    const owner = {
        _termContentMetadataArena: arena,
        _termEntryContentMetaFreeIndexes: [],
        _termEntryContentMetaDenseCount: 0,
        _termEntryContentMetaHashPairPendingCount: 0,
        _termEntryContentMetaHashPairCount: 0,
        _ensureTermEntryContentMetaHashPairCapacity() { throw new Error('Unexpected arena allocation') },
        _readTermEntryContentMetaHashPairIndex() { throw new Error('Unexpected exact lookup') },
    }
    const plan = {resolvedFlags: new Uint8Array(1), pendingEpochs: null, pendingIndexes: null}
    const context = {
        chunk: {rowCount: 1,
            contentRowStart: 0,
            contentBytesBaseOffset: 0,
            contentBytesBuffer: bytes(4),
            contentMetaList: new Uint32Array([0, 4, 1, 2]),
            contentDictNameList: null,
            uniformContentDictName: 'raw'},
        contentDedupPlan: plan,
        uniqueIndexList: new Uint32Array([0]),
        uniqueRowIndexes: new Uint32Array([0]),
        uniqueSignatures: new Uint32Array(3),
        firstUniqueIndex: 0,
        lastUniqueIndex: 1,
        persistedLookupRequired: false,
        reserveMetadata: false,
        adoptPendingColumns(_batch, complete) { complete() },
        getPendingCount: () => 0,
        exactCandidates: [],
        resolveExactCandidates: async () => {},
    }
    const scanner = new NativeCanonicalScanner({loadModule, hooks})
    const scan = () => scanner.scan(owner, context, {})
    const hash = (a, b, c) => scanner.tryHashLookupIndex(owner._termContentMetadataArena, a, b, c)
    return {arena, owner, context, scanner, scan, hash}
}

function protectedBytes(arena) {
    const buffer = arena.memory.buffer
    return [
        new Uint8Array(buffer, 1024, 152).slice(),
        new Uint8Array(buffer, layout.META, layout.usedBytes - layout.META).slice(),
        new Uint8Array(buffer, checksumLayout.END, layout.PREFIX - checksumLayout.END).slice(),
        new Uint8Array(buffer, layout.PREFIX).slice(),
    ]
}

test('combined module has no active initialization data or start function', () => {
    let position = 8
    const readLength = () => {
        let value = 0
        let shift = 0
        for (;;) {
            const byte = wasmBytes[position++]
            value |= (byte & 127) << shift
            if ((byte & 128) === 0) { return value }
            shift += 7
        }
    }
    while (position < wasmBytes.length) {
        const section = wasmBytes[position++]
        const length = readLength()
        assert.notEqual(section, 8, 'An initializer could mutate the authoritative imported memory')
        assert.notEqual(section, 11, 'Static data can collide with the canonical header at 1024')
        position += length
    }
    assert.equal(position, wasmBytes.length)
    assert(checksumLayout.STATE >= layout.usedBytes)
    assert(checksumLayout.END <= layout.PREFIX)
    assert.equal(checksumLayout.SCRATCH % 16, 0)
})

test('checksum uses only an already-created canonical instance and fixed prefix tail', async () => {
    const loadModule = vi.fn(async () => module)
    const value = fixture({loadModule})
    const source = inputs()
    const memory = value.arena.memory.buffer
    assert.equal(value.hash(...source), null)
    assert.equal(loadModule.mock.calls.length, 0)
    await value.scan()
    const saved = protectedBytes(value.arena)
    for (const length of [0, 1, 15, 16, 17, 31, 32, 1023, 1024, 20479, 20480, 20481, 40959, 40960, 40961, 65535, 65536, 65537, 1048577]) {
        const current = [bytes(length, 3), bytes(4097, 5), bytes((length * 3 + 7) % 70000, 11)]
        assert.deepEqual(value.hash(...current), expected(current), `length ${length}`)
    }
    assert.equal(value.arena.memory.buffer, memory)
    assert.deepEqual(protectedBytes(value.arena), saved)
    assert.equal(loadModule.mock.calls.length, 1)
    assert.equal(value.hash(bytes(1), bytes(1), bytes(1)), null)
})

test('canonical output and rollback owners stay intact when hashing before pending adoption', async () => {
    let calls = 0
    const source = inputs()
    const hashes = expected(source)
    const hooks = {
        beforeAdopt() {
            const saved = protectedBytes(active.arena)
            assert.deepEqual(active.hash(...source), hashes)
            assert.deepEqual(protectedBytes(active.arena), saved)
            ++calls
        },
    }
    const active = fixture({hooks})
    await active.scan()
    assert.equal(calls, 1)
    assert.equal(active.scanner.stats.nativePendingRows, 1)
})

test('unsupported sources fall back without invoking metadata, prototype, species or iterator callbacks', async () => {
    const value = fixture()
    await value.scan()
    const source = inputs()
    let calls = 0
    const shadow = bytes(4096)
    Object.defineProperty(shadow, 'buffer', {get() {
        ++calls
        throw new Error('shadow getter')
    }})
    const proxy = new Proxy(bytes(4096), {getPrototypeOf() {
        ++calls
        throw new Error('proxy trap')
    }})
    class Subarray extends Uint8Array {}
    const rejected = [shadow,
        proxy,
        new Subarray(4096),
        Buffer.alloc(4096),
        new Uint8Array(new SharedArrayBuffer(4096)),
        new Uint8Array(new ArrayBuffer(4096, {maxByteLength: 8192})),
        new Uint8Array(value.arena.memory.buffer, checksumLayout.SCRATCH, 4096),
        new Uint8Array(value.arena.memory.buffer, layout.PREFIX, 4096)]
    for (const item of rejected) { assert.equal(value.hash(item, source[1], source[2]), null) }
    assert.equal(calls, 0)

    const hashes = expected(source)
    Object.defineProperty(source[0], 'constructor', {get() {
        ++calls
        throw new Error('species lookup')
    }})
    const iterator = Array.prototype[Symbol.iterator]
    let result
    try {
        Array.prototype[Symbol.iterator] = function rejectedIterator() {
            ++calls
            throw new Error('iterator callback')
        }
        result = value.hash(source[0], source[1], source[2])
    } finally { Array.prototype[Symbol.iterator] = iterator }
    assert.equal(calls, 0)
    assert.deepEqual(result, hashes)
    const weakGet = WeakMap.prototype.get
    try {
        WeakMap.prototype.get = function rejectedWeakGet() {
            ++calls
            throw new Error('weak map callback')
        }
        result = value.hash(source[0], source[1], source[2])
    } finally { WeakMap.prototype.get = weakGet }
    assert.equal(calls, 0)
    assert.deepEqual(result, hashes)
})

test('changed hashing intrinsics retain JS behavior without invoking the replacements early', async () => {
    const value = fixture()
    await value.scan()
    const source = inputs()
    for (const [owner, key] of [[Math, 'imul'], [Number, 'isInteger'], [DataView.prototype, 'getUint32'], [DataView.prototype, 'setUint32'], [Uint8Array.prototype, 'byteLength']]) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key)
        let calls = 0
        let result
        try {
            Object.defineProperty(owner, key, {configurable: true,
                get() {
                    ++calls
                    throw new Error('replacement getter')
                }})
            result = value.hash(...source)
        } finally {
            if (descriptor) {
                Object.defineProperty(owner, key, descriptor)
            } else {
                Reflect.deleteProperty(owner, key)
            }
        }
        assert.equal(result, null)
        assert.equal(calls, 0)
    }
})

test('arena replacement and disposal cannot leave the writer bound to stale memory', async () => {
    const value = fixture()
    const source = inputs()
    const hashes = expected(source)
    await value.scan()
    assert.deepEqual(value.hash(...source), hashes)
    const oldBuffer = new Uint8Array(value.arena.memory.buffer)
    const oldSnapshot = oldBuffer.slice()
    value.owner._termContentMetadataArena = new TermContentMetadataArena(64, 128)
    assert.equal(value.hash(...source), null)
    await value.scan()
    assert.deepEqual(value.hash(...source), hashes)
    assert.deepEqual(oldBuffer, oldSnapshot)
    value.owner._termContentMetadataArena = null
    assert.equal(value.hash(...source), null)
})

test('an old module without optional exports keeps canonical scanning and JS checksum fallback', async () => {
    const OriginalInstance = WebAssembly.Instance
    const spy = vi.spyOn(WebAssembly, 'Instance').mockImplementation(function createLegacyInstance(input, imports) {
        const actual = new OriginalInstance(input, imports)
        return {exports: Object.fromEntries(Object.entries(actual.exports).filter(([name]) => !name.startsWith('xxh32_')))}
    })
    try {
        const value = fixture()
        await value.scan()
        assert.equal(value.scanner.stats.calls, 1)
        assert.equal(value.scanner.stats.fallbacks, 0)
        assert.equal(value.hash(...inputs()), null)
    } finally { spy.mockRestore() }
})

test('module failure does not make the checksum path retry acquisition or allocate memory', async () => {
    const loadModule = vi.fn(async () => { throw new Error('missing native asset') })
    const value = fixture({loadModule})
    const memory = value.arena.memory.buffer
    assert.equal(await value.scan(), null)
    assert.equal(value.hash(...inputs()), null)
    assert.equal(value.hash(...inputs()), null)
    assert.equal(loadModule.mock.calls.length, 1)
    assert.equal(value.arena.memory.buffer, memory)
})

test('native checksum failure disables only the optional helper and leaves current inputs unchanged', async () => {
    const OriginalInstance = WebAssembly.Instance
    let updates = 0
    const spy = vi.spyOn(WebAssembly, 'Instance').mockImplementation(function createTrappingInstance(input, imports) {
        const actual = new OriginalInstance(input, imports)
        return {exports: {...actual.exports,
            xxh32_update() {
                ++updates
                throw new WebAssembly.RuntimeError('injected trap')
            }}}
    })
    try {
        const value = fixture()
        await value.scan()
        const source = inputs()
        const copies = source.map((input) => input.slice())
        const saved = protectedBytes(value.arena)
        assert.equal(value.hash(...source), null)
        assert.equal(value.hash(...source), null)
        assert.equal(updates, 1)
        assert.deepEqual(source, copies)
        assert.deepEqual(protectedBytes(value.arena), saved)
        await value.scan()
        assert.equal(value.scanner.stats.calls, 2)
    } finally { spy.mockRestore() }
})

async function encodedFields(store) {
    const count = 600
    const encoder = new TextEncoder()
    const terms = Array.from({length: count}, (_, i) => encoder.encode(`term-${i}`))
    return {count,
        ...await store._encodeArtifactChunkRecords(
            {dictionary: 'Checksum test',
                rowCount: count,
                expressionBytesList: terms,
                readingBytesList: terms,
                readingEqualsExpressionList: new Uint8Array(count).fill(1),
                scoreList: new Int32Array(count),
                sequenceList: Int32Array.from({length: count}, (_, i) => i)},
            Uint32Array.from({length: count}, (_, i) => i * 4),
            new Uint32Array(count).fill(4),
        )}
}

test('writer validates before checksumming and observes current fields after its asynchronous append guard', async () => {
    const value = fixture()
    await value.scan()
    const store = new TermRecordOpfsStore()
    const encoded = await encodedFields(store)
    const provider = vi.fn(value.hash)
    await store.beginImportSession(provider)
    assert.throws(() => store._createLookupIndexChunk(1, encoded.count, 0, encoded.lookupIndexBytes, encoded.recordFields.slice(0, -1), encoded.recordFieldsFormat, provider))
    assert.equal(provider.mock.calls.length, 0)
    const state = store._createShardState('checksum.mbtr', {}, 0)
    let release
    store._validateShardAppendFormat = () => new Promise((resolve) => { release = resolve })
    const pending = store._appendEncodedChunk(
        state,
        1,
        encoded.count,
        'raw',
        0,
        encoded.lookupIndexBytes,
        encoded.recordFields,
        encoded.recordFieldsFormat,
    )
    new DataView(encoded.recordFields.buffer, encoded.recordFields.byteOffset).setInt32(16, 1234, true)
    const expectedBytes = store._createLookupIndexChunk(
        1,
        encoded.count,
        0,
        encoded.lookupIndexBytes,
        encoded.recordFields,
        encoded.recordFieldsFormat,
    )
    assert.equal(provider.mock.calls.length, 0, 'Direct repair creation must remain JS')
    release()
    await pending
    assert.equal(provider.mock.calls.length, 1)
    assert.deepEqual(state.pendingLookupIndexChunks[0], expectedBytes)
    await store.endImportSession()
    assert.equal(store._lookupChecksumProvider, null)
})

test('unsupported record metadata accessors preserve fallback access and error order', async () => {
    const value = fixture()
    await value.scan()
    const store = new TermRecordOpfsStore()
    const encoded = await encodedFields(store)
    const fields = encoded.recordFields
    const buffer = fields.buffer
    const log = []
    Object.defineProperty(fields, 'buffer', {get() {
        log.push('buffer')
        return buffer
    }})
    const create = (provider) => store._createLookupIndexChunk(
        1,
        encoded.count,
        0,
        encoded.lookupIndexBytes,
        fields,
        encoded.recordFieldsFormat,
        provider,
    )
    const original = create(null)
    const originalLog = log.splice(0)
    const candidate = create(value.hash)
    assert.deepEqual(candidate, original)
    assert.deepEqual(log, originalLog)
})

test('session completion, failed completion, rollback and prepare release the writer provider', async () => {
    for (const operation of ['end', 'failed-end', 'rollback', 'prepare']) {
        const store = new TermRecordOpfsStore()
        const provider = () => null
        await store.beginImportSession(provider)
        await store.beginImportSession(() => { throw new Error('Must preserve active session') })
        assert.equal(store._lookupChecksumProvider, provider)
        switch (operation) {
            case 'failed-end': {
                store._endImportSession = async () => { throw new Error('end failure') }
                await assert.rejects(store.endImportSession(), /end failure/u)

                break
            }
            case 'prepare': {
                store._closeAllWritables = async () => { throw new Error('close failure') }
                await assert.rejects(store._prepare(), /close failure/u)

                break
            }
            case 'rollback': {
                await store._abandonImportWritesForRollback()

                break
            }
            default: { await store.endImportSession() }
        }
        assert.equal(store._lookupChecksumProvider, null, operation)
    }
})

/* eslint-enable no-extend-native */
/* eslint-enable unicorn/prefer-spread */
