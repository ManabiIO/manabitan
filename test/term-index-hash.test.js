/* SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {afterEach, beforeEach, expect, test, vi} from 'vitest'
import {hashTermKeyBytes} from '../ext/js/dictionary/term-key-hash.js'

const moduleBytes = await readFile(new URL('../dev/data/dictionary-wasm/term-index-hash-v1.wasm', import.meta.url))
/** @type {typeof import('../ext/js/dictionary/term-index-hash.js')} */
let api

/** @param {number} length */
function payload(length) {
    return Uint8Array.from({length}, (_, i) => ((i * 131) ^ ((i >>> 7) * 17) ^ length) & 0xff)
}

/** @param {Uint8Array} [bytes] */
function respond(bytes = moduleBytes) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(bytes))))
}

beforeEach(async () => {
    vi.resetModules()
    api = await import('../ext/js/dictionary/term-index-hash.js')
})

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('keeps the synchronous JavaScript result before optional initialization', () => {
    const bytes = payload(131079)
    const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
    expect(api.hashTermIndexBytes(bytes, metrics)).toBe(hashTermKeyBytes(bytes))
    expect(metrics).toEqual({nativeHashCallCount: 0, nativeHashBytes: 0})
})

test('starts one optional request and remains usable while that request is pending', async () => {
    /** @type {(value: Response) => void} */
    let finish = () => {}
    const response = new Promise((resolve) => { finish = resolve })
    const fetch = vi.fn(() => response)
    vi.stubGlobal('fetch', fetch)
    const first = api.initializeTermIndexHash()
    const second = api.initializeTermIndexHash()
    expect(first).toBe(second)
    const bytes = payload(65536)
    expect(api.hashTermIndexBytes(bytes)).toBe(780141939)
    finish(new Response(new Uint8Array(moduleBytes)))
    expect(await first).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
})

test.each([
    [65535, 1066372610],
    [65536, 780141939],
    [65537, 2379506235],
    [1048576, 1626041054],
])('matches independent upstream XXH32 vector at %i bytes', async (length, expected) => {
    // Existing independently generated vectors in term-key-hash.test.js use
    // upstream xxhash 4.0.2 with seed 0x811c9dc5, not this writer/reader pair.
    respond()
    expect(await api.initializeTermIndexHash()).toBe(true)
    const source = payload(length)
    for (const offset of [0, 1, 3, 7, 15]) {
        const buffer = new Uint8Array(length + offset + 7).fill(0xa5)
        buffer.set(source, offset)
        const bytes = buffer.subarray(offset, offset + length)
        const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
        expect(api.hashTermIndexBytes(bytes, metrics)).toBe(expected)
        expect(metrics.nativeHashCallCount).toBe(length >= 65536 ? 1 : 0)
        expect(metrics.nativeHashBytes).toBe(length >= 65536 ? length : 0)
        expect(buffer.subarray(0, offset)).toEqual(new Uint8Array(offset).fill(0xa5))
    }
})

test('matches every tail and resets state after different streaming lengths and mutations', async () => {
    respond()
    await api.initializeTermIndexHash()
    for (const size of [65536, 131072, 196608]) {
        for (let tail = 0; tail < 16; ++tail) {
            const bytes = payload(size + tail)
            expect(api.hashTermIndexBytes(bytes)).toBe(hashTermKeyBytes(bytes))
            bytes[0] ^= 0xff
            bytes[bytes.length - 1] ^= 0x80
            expect(api.hashTermIndexBytes(bytes)).toBe(hashTermKeyBytes(bytes))
            expect(api.hashTermIndexBytes(payload(17))).toBe(1177447463)
        }
    }
})

test('retains the fallback for small, shared, resizable and caller-specialized views', async () => {
    respond()
    await api.initializeTermIndexHash()
    const shared = new Uint8Array(new SharedArrayBuffer(65536))
    const resizableBuffer = /** @type {ArrayBuffer} */ (Reflect.construct(ArrayBuffer, [65536, {maxByteLength: 131072}]))
    const resizable = new Uint8Array(resizableBuffer)
    class SpecializedBytes extends Uint8Array {}
    const specialized = new SpecializedBytes(65536)
    const shadowed = payload(65536)
    Object.defineProperty(shadowed, 'byteLength', {value: shadowed.byteLength})
    for (const bytes of [payload(65535), shared, resizable, specialized, shadowed]) {
        const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
        expect(api.hashTermIndexBytes(bytes, metrics)).toBe(hashTermKeyBytes(bytes))
        expect(metrics.nativeHashCallCount).toBe(0)
    }
})

test('copies ordinary views without invoking a caller-provided subarray method', async () => {
    respond()
    await api.initializeTermIndexHash()
    const bytes = payload(131075)
    const subarray = vi.fn(() => { throw new Error('caller subarray must not run') })
    Object.defineProperty(bytes, 'subarray', {value: subarray})
    const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
    expect(api.hashTermIndexBytes(bytes, metrics)).toBe(hashTermKeyBytes(bytes))
    expect(subarray).not.toHaveBeenCalled()
    expect(metrics).toEqual({nativeHashCallCount: 1, nativeHashBytes: bytes.byteLength})
})

test('disables a trapping accelerator, hashes unchanged bytes in JS and permits recovery', async () => {
    const native = await WebAssembly.instantiate(moduleBytes)
    const update = vi.fn(() => { throw new WebAssembly.RuntimeError('injected native trap') })
    const exports = {...native.instance.exports, update}
    // Select the byte-source overload rather than the compiled-module overload.
    const owner = /** @type {{instantiate: (bytes: BufferSource) => Promise<WebAssembly.WebAssemblyInstantiatedSource>}} */ (WebAssembly)
    const instantiate = vi.spyOn(owner, 'instantiate').mockResolvedValueOnce({
        module: native.module,
        instance: /** @type {WebAssembly.Instance} */ ({exports}),
    })
    respond()
    await api.initializeTermIndexHash()
    const bytes = payload(65536)
    const before = new Uint8Array(bytes)
    const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
    expect(api.hashTermIndexBytes(bytes, metrics)).toBe(780141939)
    expect(api.hashTermIndexBytes(bytes, metrics)).toBe(780141939)
    expect(update).toHaveBeenCalledTimes(1)
    expect(metrics.nativeHashCallCount).toBe(0)
    expect(bytes).toEqual(before)
    instantiate.mockRestore()
    respond()
    expect(await api.initializeTermIndexHash()).toBe(true)
    expect(api.hashTermIndexBytes(bytes, metrics)).toBe(780141939)
    expect(metrics.nativeHashCallCount).toBe(1)
})

test.each(['network', 'http', 'malformed', 'incompatible'])('handles %s initialization failure and permits a later retry', async (failure) => {
    if (failure === 'network') {
        vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch failure') }))
    } else if (failure === 'http') {
        vi.stubGlobal('fetch', vi.fn(async () => new Response(null, {status: 404})))
    } else {
        respond(failure === 'malformed' ? new Uint8Array([1, 2, 3]) : new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
    }
    expect(await api.initializeTermIndexHash()).toBe(false)
    expect(api.hashTermIndexBytes(payload(65536))).toBe(780141939)
    respond()
    expect(await api.initializeTermIndexHash()).toBe(true)
    const metrics = {nativeHashCallCount: 0, nativeHashBytes: 0}
    expect(api.hashTermIndexBytes(payload(65536), metrics)).toBe(780141939)
    expect(metrics.nativeHashCallCount).toBe(1)
})

test('does not wait for the optional accelerator before beginning an import', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    const {TermRecordOpfsStore} = await import('../ext/js/dictionary/term-record-opfs-store.js')
    const store = new TermRecordOpfsStore()
    await store.beginImportSession()
    expect(Reflect.get(store, '_importSessionActive')).toBe(true)
    await store.endImportSession()
    expect(store.getLastEndImportSessionMetrics()).toMatchObject({lookupIndexNativeHashCallCount: 0, lookupIndexNativeHashBytes: 0})
})

test('preserves complete index envelope bytes and rehashes caller mutations at append time', async () => {
    const {TermRecordOpfsStore} = await import('../ext/js/dictionary/term-record-opfs-store.js')
    const {encodePersistedTermLookupIndex} = await import('../ext/js/dictionary/term-lookup-index.js')
    const count = 10000
    const encoder = new TextEncoder()
    const rows = Array.from({length: count}, (_, i) => ({expressionBytes: encoder.encode(`term-${i}`), readingBytes: null, sequence: i}))
    const index = encodePersistedTermLookupIndex(rows)
    const fields = new Uint8Array(count * 12)
    const words = new Uint32Array(fields.buffer)
    for (let i = 0; i < count; ++i) {
        words[i * 3] = i * 12
        words[i * 3 + 1] = 9
        words[i * 3 + 2] = i % 11
    }
    const store = new TermRecordOpfsStore()
    const expected = store._createLookupIndexChunk(1, count, 0, index, fields, 1)
    expect(store._createLookupIndexChunk(1, count, 0, index, fields, 1, true)).toEqual(expected)
    expect(Reflect.get(store, '_lookupIndexWriteMetrics').nativeHashCallCount).toBe(0)
    respond()
    await api.initializeTermIndexHash()
    const metrics = Reflect.get(store, '_lookupIndexWriteMetrics')
    expect(store._createLookupIndexChunk(1, count, 0, index, fields, 1)).toEqual(expected)
    expect(metrics.nativeHashCallCount).toBe(0)
    const actual = store._createLookupIndexChunk(1, count, 0, index, fields, 1, true)
    expect(actual).toEqual(expected)
    expect(metrics.nativeHashCallCount).toBe(3)
    expect(metrics.nativeHashBytes).toBe(index.byteLength - 16 + fields.byteLength)
    words[2] = 1234
    const changed = store._createLookupIndexChunk(1, count, 0, index, fields, 1, true)
    expect(new DataView(changed.buffer).getUint32(32, true)).toBe(hashTermKeyBytes(fields))
    expect(changed).not.toEqual(expected)
})

test('opts in only during active import appends and keeps reader and repair hashing in JavaScript', async () => {
    respond()
    await api.initializeTermIndexHash()
    const nativeHash = vi.spyOn(api, 'hashTermIndexBytes')
    const {TermRecordOpfsStore} = await import('../ext/js/dictionary/term-record-opfs-store.js')
    const {encodePersistedTermLookupIndex} = await import('../ext/js/dictionary/term-lookup-index.js')
    const count = 10000
    const encoder = new TextEncoder()
    const rows = Array.from({length: count}, (_, i) => ({expressionBytes: encoder.encode(`term-${i}`), readingBytes: null, sequence: i}))
    const index = encodePersistedTermLookupIndex(rows)
    const fields = new Uint8Array(count * 12)
    const words = new Uint32Array(fields.buffer)
    for (let i = 0; i < count; ++i) {
        words[i * 3] = i * 12
        words[i * 3 + 1] = 9
        words[i * 3 + 2] = i % 11
    }
    const writer = new TermRecordOpfsStore()
    const handle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
        createWritable: async () => ({seek: async () => {}, write: async () => {}, close: async () => {}}),
    }))
    const state = writer._createShardState('test.mbtr', handle, 0, 'raw')
    await writer.beginImportSession()
    await writer._appendEncodedChunk(state, 1, count, 'raw', 0, index, fields, 1)
    expect(nativeHash).toHaveBeenCalledTimes(3)
    expect(Reflect.get(writer, '_lookupIndexWriteMetrics').nativeHashCallCount).toBe(3)
    const chunk = state.pendingLookupIndexChunks[0]
    const descriptor = state.pendingWriteChunks[0]
    await writer.endImportSession()
    nativeHash.mockClear()

    const ordinaryState = writer._createShardState('ordinary.mbtr', handle, 0, 'raw')
    await writer._appendEncodedChunk(ordinaryState, 1, count, 'raw', 0, index, fields, 1)
    expect(nativeHash).not.toHaveBeenCalled()
    expect(ordinaryState.pendingLookupIndexChunks[0]).toEqual(chunk)

    const header = new Uint8Array(40)
    header.set(encoder.encode('MBTIDX11'))
    const view = new DataView(header.buffer)
    view.setUint32(8, descriptor.byteLength, true)
    view.setUint32(16, 1, true)
    view.setUint32(20, count, true)
    header.set(state.generationId, 24)
    const stored = new File([new Uint8Array(header), new Uint8Array(chunk)], 'test.mbtr.mbti')
    const writable = {
        truncate: vi.fn(async () => {}), seek: vi.fn(async () => {}),
        write: vi.fn(async () => {}), close: vi.fn(async () => {}),
        abort: vi.fn(async () => {}),
    }
    const indexHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
        getFile: async () => stored,
        createWritable: async () => writable,
    }))
    const directory = /** @type {FileSystemDirectoryHandle} */ (/** @type {unknown} */ ({
        getFileHandle: async () => indexHandle,
    }))
    state.fileHandle = /** @type {FileSystemFileHandle} */ (/** @type {unknown} */ ({
        getFile: async () => new File([new Uint8Array(descriptor)], 'test.mbtr'),
    }))
    const reader = new TermRecordOpfsStore()
    Reflect.get(reader, '_shardStateByFileName').set(state.fileName, state)
    const chunks = await reader._readPersistentDictionaryIndex(directory, 'Test', [state], () => true)
    expect(chunks).toHaveLength(1)
    expect(nativeHash).not.toHaveBeenCalled()
    Reflect.set(reader, '_recordsDirectoryHandle', directory)
    await expect(reader._rebuildLookupIndexForShard(state)).resolves.toMatchObject({recordCount: count})
    expect(writable.write).toHaveBeenNthCalledWith(2, chunk)
    expect(nativeHash).not.toHaveBeenCalled()
})

test('bounds the private native workspace and rejects incomplete or invalid streaming requests', async () => {
    const {instance} = await WebAssembly.instantiate(moduleBytes)
    const exports = /** @type {import('../ext/js/dictionary/term-index-hash.js').TermIndexHashExports} */ (instance.exports)
    expect(exports.hash_abi_version()).toBe(1)
    expect(exports.memory.buffer.byteLength).toBe(131072)
    expect(() => exports.memory.grow(1)).toThrow()
    exports.reset(16)
    expect(() => exports.update(65552)).toThrow(WebAssembly.RuntimeError)
    expect(() => exports.update(15)).toThrow(WebAssembly.RuntimeError)
    expect(() => exports.digest(0)).toThrow(WebAssembly.RuntimeError)
    expect(() => exports.update(32)).toThrow(WebAssembly.RuntimeError)
    exports.update(16)
    expect(() => exports.update(16)).toThrow(WebAssembly.RuntimeError)
    expect(() => exports.digest(1)).toThrow(WebAssembly.RuntimeError)
    expect(exports.digest(0) >>> 0).toBe(hashTermKeyBytes(new Uint8Array(16)))
    // High unsigned lengths must not become negative signed cursors. These
    // unfinished requests are rejected without allocating multi-gigabyte data.
    for (const length of [0x80000000, 0x80000001, 0xffffffff]) {
        exports.reset(length)
        exports.update(65536)
        expect(() => exports.digest(length % 16)).toThrow(WebAssembly.RuntimeError)
    }
    exports.reset(0)
    expect(exports.digest(0) >>> 0).toBe(1786691832)
})
