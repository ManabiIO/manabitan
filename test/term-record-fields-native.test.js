/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {Buffer} from 'node:buffer'
import {createHash} from 'node:crypto'
import {readFileSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

/** @typedef {import('../ext/js/dictionary/term-record-fields.js').References} References */
/** @typedef {import('../ext/js/dictionary/term-record-fields.js').RecordChunk} RecordChunk */
/** @typedef {NonNullable<Awaited<ReturnType<typeof import('../ext/js/dictionary/term-record-fields.js').createImportRecordFieldEncoder>>>} Encoder */
/** @typedef {{chunk: {rowCount: number, scoreList: Int32Array, resolvedContentReferences: References}, references: References, base: number}} Fixture */
/** @typedef {(...args: number[]) => number} NativeEncode */
/** @typedef {{memory: WebAssembly.Memory, encode: NativeEncode, arguments: number[]|null, calls: number}} CapturedInstance */
/** @typedef {{invoke?: (state: CapturedInstance, args: number[]) => number, decorate?: (exports: Record<string, unknown>, state: CapturedInstance) => void}} InstanceOptions */

const wasmUrl = new URL('../ext/lib/term-record-fields.wasm', import.meta.url)
const wasmBytes = readFileSync(wasmUrl)
const wasmSha256 = '8556f66c8af26ac3c0386f7ca068ffb10a5bd8949e34facde7e8451d46bf4e7a'
const nativeCompile = WebAssembly.compile
const NativeModule = WebAssembly.Module
const NativeMemory = WebAssembly.Memory
const NativeInstance = WebAssembly.Instance
/** @type {WeakMap<object, References>} */
const origins = new WeakMap()
/** @type {Encoder[]} */
let encoders = []

/** @returns {Response} */
function response() {
    const body = new ArrayBuffer(wasmBytes.byteLength)
    new Uint8Array(body).set(wasmBytes)
    return new Response(body)
}

/** @returns {import('vitest').Mock<(input: unknown) => Promise<Response>>} */
function createFetchMock() {
    return vi.fn(async (/** @type {unknown} */ input) => {
        expect(String(input)).toBe(wasmUrl.href)
        return response()
    })
}

let fetchMock = createFetchMock()

/**
 * This witness models only ownership of the controlled fixture. Production
 * factory-origin, fixed-span and ordinary-object checks belong to store tests.
 * @param {RecordChunk} chunk
 * @returns {References|null}
 */
function privateReferences(chunk) {
    return origins.get(chunk) ?? null
}

/**
 * @param {number} [count=64]
 * @param {(index: number) => number} [score]
 * @returns {Fixture}
 */
function fixture(count = 64, score = (index) => [0, -2147483648, 2147483647, -10100301, 1999800][index % 5]) {
    const references = {
        uniqueIndexList: Uint32Array.from({length: count}, (_, index) => index % 8),
        offsets: Float64Array.from({length: 8}, (_, index) => 1000 + index * 10),
        lengths: Uint32Array.from({length: 8}, (_, index) => index),
    }
    const chunk = {rowCount: count, scoreList: Int32Array.from({length: count}, (_, index) => score(index)), resolvedContentReferences: references}
    origins.set(chunk, references)
    return {chunk, references, base: 1000}
}

/**
 * A format oracle independent of the native scratch layout and hash table.
 * @param {Fixture} value
 * @returns {Uint8Array}
 */
function compactBytes(value) {
    const {chunk, references, base} = value
    const scores = [...new Set(chunk.scoreList)]
    /** @type {Map<number, number>} */
    const scoreKeys = new Map()
    for (const [index, score] of scores.entries()) { scoreKeys.set(score, index) }
    const output = new Uint8Array(16 + scores.length * 4 + chunk.rowCount * 8)
    const view = new DataView(output.buffer)
    view.setUint32(0, 0x3246524d, true)
    view.setUint32(4, chunk.rowCount, true)
    view.setUint32(8, scores.length, true)
    view.setUint32(12, 2, true)
    for (const [index, score] of scores.entries()) { view.setInt32(16 + index * 4, score, true) }
    const offsetsStart = 16 + scores.length * 4
    const lengthsStart = offsetsStart + chunk.rowCount * 4
    const keysStart = lengthsStart + chunk.rowCount * 2
    for (let row = 0; row < chunk.rowCount; ++row) {
        const unique = references.uniqueIndexList[row]
        const offset = references.offsets[unique]
        view.setUint32(offsetsStart + row * 4, offset === -1 ? 0xffffffff : offset - base, true)
        view.setUint16(lengthsStart + row * 2, references.lengths[unique], true)
        view.setUint16(keysStart + row * 2, scoreKeys.get(chunk.scoreList[row]) ?? 0, true)
    }
    return output
}

/** @returns {Promise<typeof import('../ext/js/dictionary/term-record-fields.js')>} */
async function loadHelper() {
    return await import('../ext/js/dictionary/term-record-fields.js')
}

/** @returns {Promise<Encoder>} @throws {Error} */
async function prepare() {
    const {createImportRecordFieldEncoder} = await loadHelper()
    const encoder = await createImportRecordFieldEncoder()
    if (encoder === null) { throw new Error('Expected the actual native helper to initialize') }
    encoders.push(encoder)
    return encoder
}

/** @param {Record<string, unknown>} overrides @returns {void} */
function replaceWebAssembly(overrides) {
    vi.stubGlobal('WebAssembly', {
        compile: nativeCompile,
        Module: NativeModule,
        Memory: NativeMemory,
        Instance: NativeInstance,
        ...overrides,
    })
}

/**
 * Capture the imported memory at the standard constructor seam, not through a
 * product accessor. The real unchanged kernel still executes unless injected.
 * @param {InstanceOptions} [options={}]
 * @returns {CapturedInstance[]}
 */
function captureInstances(options = {}) {
    /** @type {CapturedInstance[]} */
    const instances = []
    class CapturedNativeInstance {
        /** @param {WebAssembly.Module} module @param {WebAssembly.Imports} imports */
        constructor(module, imports) {
            const instance = new NativeInstance(module, imports)
            const memory = imports.env.memory
            const encode = instance.exports.encode_record_fields
            if (!(memory instanceof NativeMemory) || typeof encode !== 'function') { throw new Error('Unexpected test ABI') }
            /** @type {CapturedInstance} */
            const state = {memory, encode: /** @type {NativeEncode} */ (encode), arguments: null, calls: 0}
            instances.push(state)
            /** @type {Record<string, unknown>} */
            const exports = {...instance.exports}
            exports.encode_record_fields = (/** @type {number[]} */ ...args) => {
                state.arguments = [...args]
                ++state.calls
                return typeof options.invoke === 'function' ? options.invoke(state, args) : state.encode(...args)
            }
            options.decorate?.(exports, state)
            this.exports = exports
        }
    }
    replaceWebAssembly({Instance: CapturedNativeInstance})
    return instances
}

/** @param {CapturedInstance[]} instances @returns {CapturedInstance} @throws {Error} */
function firstInstance(instances) {
    const value = instances[0]
    if (typeof value === 'undefined') { throw new Error('Expected one captured native instance') }
    return value
}

/**
 * Compare every byte without Vitest traversing a large typed array as an object.
 * Buffer views borrow only within this synchronous assertion.
 * @param {Uint8Array|null} actual
 * @param {Uint8Array} expected
 * @returns {Uint8Array}
 * @throws {Error}
 */
function expectBytes(actual, expected) {
    if (actual === null) { throw new Error('Expected owning native output bytes') }
    expect(actual.byteLength).toBe(expected.byteLength)
    expect(Buffer.compare(
        Buffer.from(actual.buffer, actual.byteOffset, actual.byteLength),
        Buffer.from(expected.buffer, expected.byteOffset, expected.byteLength),
    )).toBe(0)
    return actual
}

/** @param {Encoder} encoder @param {Fixture} value @returns {Uint8Array|null} */
function encode(encoder, value) {
    return encoder.tryEncode(value.chunk, value.base, privateReferences)
}

/**
 * @param {Encoder} encoder
 * @param {Fixture} value
 * @param {string} reason
 * @returns {void}
 */
function expectDecline(encoder, value, reason) {
    expect(encode(encoder, value)).toBeNull()
    expect(encoder.getDiagnostics().declines[reason]).toBe(1)
}

/** @param {number} value @returns {number} */
function mixScore(value) {
    value = Math.imul(value ^ (value >>> 16), 0x7feb352d)
    value = Math.imul(value ^ (value >>> 15), 0x846ca68b)
    return (value ^ (value >>> 16)) >>> 0
}

beforeEach(() => {
    vi.resetModules()
    fetchMock = createFetchMock()
    vi.stubGlobal('fetch', fetchMock)
    encoders = []
})

afterEach(() => {
    for (const encoder of encoders) { encoder.dispose() }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe('native record-field asset and initialization', () => {
    test('uses the reviewed kernel and waits for the real asset without eager import-time fetch', async () => {
        expect(wasmBytes.byteLength).toBe(1753)
        expect(createHash('sha256').update(wasmBytes).digest('hex')).toBe(wasmSha256)
        const helper = await loadHelper()
        expect(fetchMock).not.toHaveBeenCalled()
        const encoder = await helper.createImportRecordFieldEncoder()
        expect(encoder).not.toBeNull()
        encoder?.dispose()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test.each(['fetch rejection', 'HTTP failure', 'invalid module'])('retries after %s', async (failure) => {
        if (failure === 'fetch rejection') {
            fetchMock.mockRejectedValueOnce(new Error('Controlled fetch failure'))
        } else if (failure === 'HTTP failure') {
            fetchMock.mockResolvedValueOnce(new Response(null, {status: 503}))
        } else {
            fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([0]).buffer))
        }
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        const encoder = await prepare()
        expectBytes(encode(encoder, fixture()), compactBytes(fixture()))
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('retries an invalid module import interface', async () => {
        const imports = vi.spyOn(NativeModule, 'imports').mockReturnValueOnce([])
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        const encoder = await prepare()
        expectBytes(encode(encoder, fixture()), compactBytes(fixture()))
        expect(imports).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test('retries an invalid module export interface', async () => {
        const exports = vi.spyOn(NativeModule, 'exports').mockReturnValueOnce([
            {name: 'record_fields_abi_version', kind: 'function'},
        ])
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        await prepare()
        expect(exports).toHaveBeenCalledTimes(2)
        expect(fetchMock).toHaveBeenCalledTimes(2)
    })

    test.each(['wrong version', 'throwing ABI', 'missing encoder'])('retries an instance with %s', async (failure) => {
        let fail = true
        const instances = captureInstances({
            decorate(exports) {
                if (!fail) { return }
                if (failure === 'missing encoder') {
                    exports.encode_record_fields = 0
                } else {
                    exports.record_fields_abi_version = () => {
                        if (failure === 'throwing ABI') { throw new Error('Controlled ABI failure') }
                        return 2
                    }
                }
            },
        })
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        fail = false
        const encoder = await prepare()
        expect(encode(encoder, fixture())).not.toBeNull()
        expect(instances).toHaveLength(2)
        expect(instances[0].memory).not.toBe(instances[1].memory)
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('retries instance allocation without retaining a failed private state', async () => {
        class FailingInstance {
            constructor() { throw new Error('Controlled instance failure') }
        }
        replaceWebAssembly({Instance: FailingInstance})
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        replaceWebAssembly({})
        expect(encode(await prepare(), fixture())).not.toBeNull()
        expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('shares only compiled module work across concurrent preparations', async () => {
        const instances = captureInstances()
        const compile = vi.fn(nativeCompile)
        replaceWebAssembly({Instance: WebAssembly.Instance, compile})
        const {createImportRecordFieldEncoder} = await loadHelper()
        const prepared = await Promise.all([createImportRecordFieldEncoder(), createImportRecordFieldEncoder()])
        const first = prepared[0]
        const second = prepared[1]
        if (first === null || second === null) { throw new Error('Expected both native sessions') }
        encoders.push(first, second)
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(compile).toHaveBeenCalledTimes(1)
        expect(instances).toHaveLength(2)
        expect(instances[0].memory.buffer).not.toBe(instances[1].memory.buffer)
        first.dispose()
        expect(encode(first, fixture())).toBeNull()
        expectBytes(encode(second, fixture()), compactBytes(fixture()))
    })

    test('declines without fetching when WebAssembly is unavailable', async () => {
        vi.stubGlobal('WebAssembly', undefined)
        const {createImportRecordFieldEncoder} = await loadHelper()
        await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
        expect(fetchMock).not.toHaveBeenCalled()
    })

    test('declines on browsers without the resizable-buffer intrinsic', async () => {
        const descriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')
        if (typeof descriptor === 'undefined') { throw new Error('Expected Node test intrinsic') }
        expect(Reflect.deleteProperty(ArrayBuffer.prototype, 'resizable')).toBe(true)
        try {
            const {createImportRecordFieldEncoder} = await loadHelper()
            await expect(createImportRecordFieldEncoder()).resolves.toBeNull()
            expect(fetchMock).not.toHaveBeenCalled()
        } finally {
            Object.defineProperty(ArrayBuffer.prototype, 'resizable', descriptor)
        }
    })
})

describe('native record-field complete bytes', () => {
    test('preserves first-use score ordering, integer extremes and every field byte', async () => {
        const encoder = await prepare()
        const value = fixture()
        expectBytes(encode(encoder, value), compactBytes(value))
        const diagnostics = encoder.getDiagnostics()
        expect(diagnostics.nativeCalls).toBe(1)
        expect(diagnostics.nativeRows).toBe(64)
        expect(diagnostics.inputCopiedBytes).toBe(64 * 8 + 8 * 12)
        expect(diagnostics.outputCopiedBytes).toBe(16 + 5 * 4 + 64 * 8)
        expect(diagnostics.declines).toEqual({})
    })

    test('preserves null offsets, repeated references and maximum compact length', async () => {
        const value = fixture()
        value.references.offsets[0] = -1
        value.references.lengths[0] = 65534
        value.references.uniqueIndexList[4] = 0
        value.references.uniqueIndexList[5] = 0
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test('preserves a large safe base and maximum encodable offset delta', async () => {
        const value = fixture()
        value.base = 2 ** 52
        value.references.offsets.set([
            value.base, value.base + 4294967294, value.base + 1, value.base + 2,
            value.base + 3, value.base + 4, value.base + 5, value.base + 6,
        ])
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test('copies the correct subviews with nonzero byte offsets', async () => {
        const value = fixture()
        const indexes = new Uint32Array(new ArrayBuffer(272), 8, 64)
        const scores = new Int32Array(new ArrayBuffer(272), 8, 64)
        const offsets = new Float64Array(new ArrayBuffer(96), 16, 8)
        const lengths = new Uint32Array(new ArrayBuffer(48), 8, 8)
        indexes.set(value.references.uniqueIndexList)
        scores.set(value.chunk.scoreList)
        offsets.set(value.references.offsets)
        lengths.set(value.references.lengths)
        Object.assign(value.references, {uniqueIndexList: indexes, offsets, lengths})
        value.chunk.scoreList = scores
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test('preserves legal aliases between private input columns', async () => {
        const value = fixture()
        const shared = new Uint32Array(64).fill(1)
        value.references.uniqueIndexList = shared
        value.references.lengths = shared
        value.references.offsets = new Float64Array(64).fill(value.base)
        value.chunk.scoreList = new Int32Array(shared.buffer)
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test('rereads current columns on every call while preserving earlier outputs', async () => {
        const encoder = await prepare()
        const value = fixture()
        const first = expectBytes(encode(encoder, value), compactBytes(value))
        const saved = first.slice()
        value.chunk.scoreList.fill(-911)
        value.references.offsets.fill(value.base + 9000)
        value.references.lengths.fill(51)
        const second = encode(encoder, value)
        expectBytes(second, compactBytes(value))
        expect(second?.byteLength).not.toBe(first.byteLength)
        expectBytes(first, saved)
        expect(encoder.getDiagnostics().nativeCalls).toBe(2)
    })

    test('keeps compact first-occurrence score cardinality below the reserved key', async () => {
        const value = fixture(131068, (index) => (index % 65534) - 32767)
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test.each([65535, 65536])('declines reserved or excessive score cardinality %i', async (cardinality) => {
        const encoder = await prepare()
        const value = fixture(cardinality * 2, (index) => index % cardinality)
        expectDecline(encoder, value, 'unsupported-compact')
        expect(encode(encoder, fixture())).not.toBeNull()
    })

    test('preserves score collisions within the bounded probe budget', async () => {
        /** @type {number[]} */
        const scores = []
        for (let score = 0; scores.length < 8; ++score) {
            if ((mixScore(score) & 127) === 0) { scores.push(score) }
        }
        const value = fixture(64, (index) => scores[index % scores.length])
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test('declines adversarial probe exhaustion and remains available for ordinary input', async () => {
        /** @type {number[]} */
        const scores = []
        for (let score = 0; scores.length < 64; ++score) {
            if ((mixScore(score) & 511) === 0) { scores.push(score) }
        }
        const encoder = await prepare()
        expectDecline(encoder, fixture(256, (index) => scores[index % scores.length]), 'unsupported-compact')
        expect(encode(encoder, fixture())).not.toBeNull()
    })

    test.each([0, 1, 5])('declines empty or non-smaller compact output at %i rows', async (count) => {
        const encoder = await prepare()
        expect(encode(encoder, fixture(count, () => 0))).toBeNull()
        expect(encoder.getDiagnostics().nativeCalls).toBe(0)
    })

    test('admits the first strictly smaller one-score compact size', async () => {
        const value = fixture(6, () => 0)
        const bytes = encode(await prepare(), value)
        expectBytes(bytes, compactBytes(value))
        expect(bytes?.byteLength).toBe(68)
    })
})

describe('native record-field guarded nullable fallback', () => {
    test('does not inspect a chunk rejected by the private ownership witness', async () => {
        const encoder = await prepare()
        const value = fixture()
        const read = vi.fn(() => { throw new Error('Must not read unowned input') })
        Object.defineProperty(value.chunk, 'rowCount', {get: read})
        const witness = vi.fn(() => null)
        expect(encoder.tryEncode(value.chunk, value.base, witness)).toBeNull()
        expect(witness).toHaveBeenCalledWith(value.chunk, 0)
        expect(read).not.toHaveBeenCalled()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test('contains witness exceptions without invoking a stock callback', async () => {
        const encoder = await prepare()
        const value = fixture()
        const witness = vi.fn(() => { throw new RangeError('Controlled witness failure') })
        expect(encoder.tryEncode(value.chunk, value.base, witness)).toBeNull()
        expect(witness).toHaveBeenCalledOnce()
        expect(encoder.getDiagnostics().declines['guard-exception']).toBe(1)
        expect(encode(encoder, fixture())).not.toBeNull()
    })

    test.each(['rowCount', 'scoreList'])('does not invoke a %s accessor', async (property) => {
        const value = fixture()
        const read = vi.fn(() => { throw new Error('Unexpected chunk accessor') })
        Object.defineProperty(value.chunk, property, {get: read})
        expect(encode(await prepare(), value)).toBeNull()
        expect(read).not.toHaveBeenCalled()
    })

    test.each(['own value', 'own getter', 'inherited value', 'inherited getter'])(
        'rejects a fixed content base supplied as %s without invoking accessors',
        async (kind) => {
            const value = fixture()
            const read = vi.fn(() => { throw new Error('Unexpected fixed-base accessor') })
            const descriptor = kind.includes('getter') ? {get: read} : {value: value.base}
            if (kind.startsWith('inherited')) {
                const prototype = Object.create(Object.prototype)
                Object.defineProperty(prototype, 'fixedContentOffsetBase', descriptor)
                Object.setPrototypeOf(value.chunk, prototype)
            } else {
                Object.defineProperty(value.chunk, 'fixedContentOffsetBase', descriptor)
            }
            expect(encode(await prepare(), value)).toBeNull()
            expect(read).not.toHaveBeenCalled()
        },
    )

    test('accepts an own undefined fixed-base marker', async () => {
        const value = fixture()
        Object.defineProperty(value.chunk, 'fixedContentOffsetBase', {value: undefined})
        expectBytes(encode(await prepare(), value), compactBytes(value))
    })

    test.each(['scores', 'indexes', 'offsets', 'lengths'])('rejects the forged element kind of %s', async (kind) => {
        const value = fixture()
        if (kind === 'scores') {
            const column = new Uint16Array(64)
            Object.setPrototypeOf(column, Int32Array.prototype)
            Reflect.set(value.chunk, 'scoreList', column)
        } else if (kind === 'offsets') {
            const column = new Float32Array(8)
            Object.setPrototypeOf(column, Float64Array.prototype)
            Reflect.set(value.references, 'offsets', column)
        } else {
            const column = new Uint16Array(kind === 'indexes' ? 64 : 8)
            Object.setPrototypeOf(column, Uint32Array.prototype)
            Reflect.set(value.references, kind === 'indexes' ? 'uniqueIndexList' : 'lengths', column)
        }
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test.each(['buffer', 'byteOffset', 'byteLength', 'length', Symbol.toStringTag])(
        'rejects an own column shadow %s without reading it',
        async (property) => {
            const value = fixture()
            const read = vi.fn(() => { throw new Error('Unexpected column accessor') })
            Object.defineProperty(value.chunk.scoreList, property, {get: read})
            const encoder = await prepare()
            expect(encode(encoder, value)).toBeNull()
            expect(read).not.toHaveBeenCalled()
            expect(encoder.getDiagnostics().nativeAttempts).toBe(0)
        },
    )

    test.each(['scores', 'indexes', 'offsets', 'lengths'])('rejects shared %s storage', async (kind) => {
        const value = fixture()
        if (kind === 'scores') {
            value.chunk.scoreList = new Int32Array(new SharedArrayBuffer(256))
        } else if (kind === 'indexes') {
            value.references.uniqueIndexList = new Uint32Array(new SharedArrayBuffer(256))
        } else if (kind === 'offsets') {
            value.references.offsets = new Float64Array(new SharedArrayBuffer(64))
        } else {
            value.references.lengths = new Uint32Array(new SharedArrayBuffer(32))
        }
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
        expect(encoder.getDiagnostics().nativeAttempts).toBe(0)
    })

    test('rejects a resizable input buffer', async () => {
        const value = fixture()
        value.chunk.scoreList = new Int32Array(new ArrayBuffer(256, {maxByteLength: 512}))
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test('rejects detached input without escaping a guard error', async () => {
        const value = fixture()
        const buffer = value.chunk.scoreList.buffer
        structuredClone(buffer, {transfer: [buffer]})
        expect(encode(await prepare(), value)).toBeNull()
    })

    test.each([-1, 0, 1.5, NaN, Infinity, 0x100000000])('rejects invalid row count %s before copying', async (count) => {
        const value = fixture()
        value.chunk.rowCount = count
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test.each(['short indexes', 'short scores', 'unequal references', 'empty references'])(
        'rejects %s before entering the native ABI',
        async (kind) => {
            const value = fixture()
            if (kind === 'short indexes') {
                value.references.uniqueIndexList = new Uint32Array(63)
            } else if (kind === 'short scores') {
                value.chunk.scoreList = new Int32Array(63)
            } else if (kind === 'unequal references') {
                value.references.offsets = new Float64Array(9)
            } else {
                value.references.offsets = new Float64Array(0)
                value.references.lengths = new Uint32Array(0)
            }
            const encoder = await prepare()
            expect(encode(encoder, value)).toBeNull()
            expect(encoder.getDiagnostics().nativeAttempts).toBe(0)
        },
    )

    test.each([NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects unsafe base %s', async (base) => {
        const value = fixture()
        value.base = base
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test.each([NaN, Infinity, -2, 1000.5, Number.MAX_SAFE_INTEGER + 1, 999, 1000 + 4294967295])(
        'declines malformed or unencodable native offset %s',
        async (offset) => {
            const value = fixture()
            value.references.offsets[0] = offset
            const encoder = await prepare()
            expect(encode(encoder, value)).toBeNull()
            expect(encoder.getDiagnostics().nativeCalls).toBe(0)
            expect(encoder.getDiagnostics().nativeAttempts).toBe(1)
        },
    )

    test('declines an out-of-range unique index without publishing bytes', async () => {
        const value = fixture()
        value.references.uniqueIndexList[7] = 8
        const encoder = await prepare()
        expectDecline(encoder, value, 'native-return')
        expect(encoder.getDiagnostics().outputCopiedBytes).toBe(0)
    })

    test.each([65535, 0xffffffff])('keeps unsupported compact length %i available for JS fallback', async (length) => {
        const value = fixture()
        value.references.lengths[0] = length
        const encoder = await prepare()
        expectDecline(encoder, value, 'unsupported-compact')
        expect(encode(encoder, fixture())).not.toBeNull()
    })

    test.each(['floating', 'ordinary', 'proxy'])('declines %s scores', async (kind) => {
        const value = fixture()
        const scores = kind === 'floating' ?
            Float64Array.from({length: 64}, (_, index) => [1.5, -0, 2 ** 40, Infinity, NaN][index % 5]) :
            kind === 'ordinary' ?
                Array.from({length: 64}, (_, index) => index % 2 === 0 ? null : undefined) :
                new Proxy(value.chunk.scoreList, {})
        Reflect.set(value.chunk, 'scoreList', scores)
        const encoder = await prepare()
        expect(encode(encoder, value)).toBeNull()
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })
})

describe('native record-field memory, result and lifetime boundaries', () => {
    test('declines the private memory cap before copying or growing', async () => {
        const value = fixture(0)
        value.chunk.rowCount = 3100000
        value.chunk.scoreList = new Int32Array(value.chunk.rowCount)
        value.references.uniqueIndexList = new Uint32Array(value.chunk.rowCount)
        const encoder = await prepare()
        expectDecline(encoder, value, 'memory-bound')
        const diagnostics = encoder.getDiagnostics()
        expect(diagnostics.inputCopiedBytes).toBe(0)
        expect(diagnostics.memoryGrowthBytes).toBe(0)
        expect(diagnostics.nativeAttempts).toBe(0)
        expect(diagnostics.maximumLinearMemoryBytes).toBe(2 * 65536)
    })

    test('contains native memory growth failure and disables that instance', async () => {
        class GrowthFailureMemory extends NativeMemory {
            /** @returns {never} @throws {RangeError} */
            grow() { throw new RangeError('Controlled memory growth failure') }
        }
        replaceWebAssembly({Memory: GrowthFailureMemory})
        const encoder = await prepare()
        expectDecline(encoder, fixture(), 'memory-growth')
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
        expectDecline(encoder, fixture(), 'unavailable')
    })

    test.each([false, true])('rejects native-memory aliases before copying; pre-grown=%s', async (growFirst) => {
        const captured = captureInstances()
        const encoder = await prepare()
        const state = firstInstance(captured)
        if (growFirst) { state.memory.grow(8) }
        const memory = state.memory.buffer
        const value = fixture()
        value.references.uniqueIndexList = new Uint32Array(memory, 0, 64)
        value.chunk.scoreList = new Int32Array(memory, 256, 64).fill(-200)
        value.references.offsets = new Float64Array(memory, 512, 8).fill(value.base)
        value.references.lengths = new Uint32Array(memory, 576, 8).fill(5)
        const before = new Uint8Array(memory).slice()
        expectDecline(encoder, value, 'native-memory-alias')
        expect(state.memory.buffer).toBe(memory)
        expectBytes(new Uint8Array(memory), before)
        expect(state.calls).toBe(0)
        expect(encoder.getDiagnostics().inputCopiedBytes).toBe(0)
    })

    test('keeps returned bytes independent through native reuse, growth and disposal', async () => {
        const captured = captureInstances()
        const encoder = await prepare()
        const first = encode(encoder, fixture())
        if (first === null) { throw new Error('Expected first owning output') }
        const saved = first.slice()
        const state = firstInstance(captured)
        const beforeGrowth = state.memory.buffer.byteLength
        expect(first.buffer).not.toBe(state.memory.buffer)
        const second = fixture(150000, (index) => index % 200)
        expectBytes(encode(encoder, second), compactBytes(second))
        expect(state.memory.buffer.byteLength).toBeGreaterThan(beforeGrowth)
        new Uint8Array(state.memory.buffer).fill(123)
        encoder.dispose()
        encoder.dispose()
        expectBytes(first, saved)
        expectDecline(encoder, fixture(), 'unavailable')
    })

    test('returns detached diagnostic records and decline counters', async () => {
        const encoder = await prepare()
        expectDecline(encoder, fixture(0), 'eligibility')
        const value = fixture()
        expectBytes(encode(encoder, value), compactBytes(value))
        const copy = encoder.getDiagnostics()
        copy.nativeCalls = 100
        copy.nativeRows = 0
        copy.declines.eligibility = 999
        copy.declines.injected = 1
        expect(encoder.getDiagnostics().nativeCalls).toBe(1)
        expect(encoder.getDiagnostics().nativeRows).toBe(64)
        expect(encoder.getDiagnostics().declines).toEqual({eligibility: 1})
    })

    test.each(['trap', 'negative', 'fractional', 'too small', 'too large', 'nonfinite'])(
        'contains %s native results and disables further native entry',
        async (fault) => {
            const captured = captureInstances({
                invoke() {
                    if (fault === 'trap') { throw new Error('Controlled native trap') }
                    if (fault === 'negative') { return -99 }
                    if (fault === 'fractional') { return 20.5 }
                    if (fault === 'too small') { return 19 }
                    if (fault === 'nonfinite') { return Infinity }
                    return 2 ** 31
                },
            })
            const encoder = await prepare()
            expect(encode(encoder, fixture())).toBeNull()
            expect(encode(encoder, fixture())).toBeNull()
            expect(firstInstance(captured).calls).toBe(1)
            expect(encoder.getDiagnostics().nativeCalls).toBe(0)
            expect(encoder.getDiagnostics().outputCopiedBytes).toBe(0)
            expect(encoder.getDiagnostics().declines.unavailable).toBe(1)
        },
    )

    test.each(['magic', 'rows', 'version', 'zero scores', 'reserved scores', 'score capacity', 'length'])(
        'rejects a malformed compact %s before publishing an output',
        async (fault) => {
            const captured = captureInstances({
                invoke(state, args) {
                    const result = state.encode(...args)
                    const header = new Uint32Array(state.memory.buffer, args[11], 4)
                    if (fault === 'magic') { header[0] = 0 }
                    if (fault === 'rows') { header[1] = 0 }
                    if (fault === 'version') { header[3] = 1 }
                    if (fault === 'zero scores') { header[2] = 0 }
                    if (fault === 'reserved scores') { header[2] = 65535 }
                    if (fault === 'score capacity') { header[2] = 65 }
                    return fault === 'length' ? result + 4 : result
                },
            })
            const encoder = await prepare()
            expectDecline(encoder, fixture(), 'native-header')
            expectDecline(encoder, fixture(), 'unavailable')
            expect(firstInstance(captured).calls).toBe(1)
            expect(encoder.getDiagnostics().outputCopiedBytes).toBe(0)
        },
    )

    test.each([1, 5])('contains copy failure at copy %i and disables the private arena', async (failureAt) => {
        const encoder = await prepare()
        const value = fixture()
        const originalSet = Uint8Array.prototype.set
        let copies = 0
        const set = vi.spyOn(Uint8Array.prototype, 'set').mockImplementation(
            /** @this {Uint8Array} */
            function (source, offset) {
                if (++copies === failureAt) { throw new Error('Controlled copy failure') }
                originalSet.call(this, source, offset)
            },
        )
        const result = encode(encoder, value)
        set.mockRestore()
        expect(result).toBeNull()
        expect(encoder.getDiagnostics().declines[failureAt === 1 ? 'input-copy' : 'output-copy']).toBe(1)
        expect(encoder.getDiagnostics().nativeCalls).toBe(0)
        expect(encoder.getDiagnostics().outputCopiedBytes).toBe(0)
        expectDecline(encoder, fixture(), 'unavailable')
    })

    test.each([2, 3, 4, 5, 7, 9, 10, 11])('native ABI rejects invalid region argument %i', async (index) => {
        const captured = captureInstances()
        const encoder = await prepare()
        expect(encode(encoder, fixture())).not.toBeNull()
        const state = firstInstance(captured)
        const original = state.arguments
        if (original === null) { throw new Error('Expected actual ABI arguments') }
        for (const replacement of [
            0, original[index] + 1, state.memory.buffer.byteLength,
            index === 2 ? original[3] : original[2],
        ]) {
            const args = [...original]
            args[index] = replacement
            expect(state.encode(...args)).toBeLessThan(0)
        }
    })

    test('native ABI rejects malformed dimensions, base, slots and output capacity', async () => {
        const captured = captureInstances()
        const encoder = await prepare()
        expect(encode(encoder, fixture())).not.toBeNull()
        const state = firstInstance(captured)
        const original = state.arguments
        if (original === null) { throw new Error('Expected actual ABI arguments') }
        for (const [index, value] of [[0, 0xffffffff], [6, NaN], [8, 3], [12, 1], [12, 0xffffffff]]) {
            const args = [...original]
            args[index] = value
            expect(state.encode(...args)).toBeLessThan(0)
        }
    })
})
