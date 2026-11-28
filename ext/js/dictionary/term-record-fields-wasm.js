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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

const MAX_ROWS = 262_144
const MAX_UNIQUE = 262_144
const MAX_BYTES = 8 * 1024 * 1024
const PAGE_BYTES = 65_536
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get
const getByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'length')?.get
const getArrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const setTypedArray = Uint8Array.prototype.set
/** @type {Promise<WebAssembly.Module>|null} */
let modulePromise = null

/** @typedef {{uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}} RecordFieldReferences */
/** @typedef {{buffer: ArrayBuffer, byteOffset: number, length: number}} Column */

/** @returns {Promise<WebAssembly.Module>} */
function compileRecordFieldsModule() {
    modulePromise ??= (async () => {
        const response = await fetch(new URL('../../lib/term-record-fields-v1.wasm', import.meta.url))
        if (!response.ok) { throw new Error(`Failed to load record fields WASM: ${response.status}`) }
        return await WebAssembly.compile(await response.arrayBuffer())
    })().catch((error) => {
        modulePromise = null
        throw error
    })
    return modulePromise
}

/**
 * Capture intrinsic view metadata without reading replaceable methods or own
 * accessors. The ArrayBuffer getter rejects shared storage and prototype fakes.
 * The caller separately proves the chunk and reference object factory origin.
 * @param {unknown} value
 * @param {object} prototype
 * @returns {Column|null}
 */
function getPrivateColumn(value, prototype) {
    if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototype ||
        typeof getBuffer !== 'function' || typeof getByteOffset !== 'function' ||
        typeof getLength !== 'function' || typeof getArrayBufferByteLength !== 'function') { return null }
    try {
        const buffer = /** @type {ArrayBuffer} */ (getBuffer.call(value))
        getArrayBufferByteLength.call(buffer)
        return {buffer, byteOffset: getByteOffset.call(value), length: getLength.call(value)}
    } catch { return null }
}

/**
 * One import owns each instance and its bounded scratch memory. Only compiled
 * immutable code survives the session. Every invocation copies current columns
 * and returns owned bytes; no source witness is reused across an await.
 */
export class NativeRecordFieldEncoder {
    /** @param {{loadModule?: () => Promise<WebAssembly.Module>}} [dependencies] */
    constructor({loadModule = compileRecordFieldsModule} = {}) {
        /** @type {() => Promise<WebAssembly.Module>} */
        this._loadModule = loadModule
        /** @type {Promise<boolean>|null} */
        this._preparePromise = null
        /** @type {WebAssembly.Memory|null} */
        this._memory = null
        /** @type {((count: number, uniqueCount: number, base: number) => number)|null} */
        this._encode = null
        /** @type {number} */
        this._start = 0
        /** @type {boolean} */
        this._disposed = false
    }

    /** @returns {Promise<boolean>} */
    prepare() {
        if (this._disposed) { return Promise.resolve(false) }
        this._preparePromise ??= (async () => {
            const module = await this._loadModule()
            if (this._disposed) { return false }
            const memory = new WebAssembly.Memory({initial: 2, maximum: MAX_BYTES / PAGE_BYTES})
            const instance = new WebAssembly.Instance(module, {env: {memory}})
            const exports = /** @type {{record_fields_abi_version: () => number, record_fields_scratch_start: () => number, encode_record_fields: (count: number, uniqueCount: number, base: number) => number}} */ (instance.exports)
            if (typeof exports.record_fields_abi_version !== 'function' || exports.record_fields_abi_version() !== 1 ||
                typeof exports.record_fields_scratch_start !== 'function' || typeof exports.encode_record_fields !== 'function') { return false }
            const start = exports.record_fields_scratch_start()
            if (!Number.isSafeInteger(start) || start <= 0 || start % 8 !== 0 || start >= memory.buffer.byteLength) { return false }
            this._memory = memory
            this._encode = exports.encode_record_fields
            this._start = start
            return true
        })().catch(() => false)
        return this._preparePromise
    }

    /** Stops pending preparation and releases this import's scratch memory. */
    dispose() {
        this._disposed = true
        this._memory = null
        this._encode = null
    }

    /**
     * Returns null for unavailable or unsupported compact input. Existing JS
     * retains validation errors and the legacy/float64 formats in those cases.
     * @param {number} count Captured row count, never a fresh chunk getter read.
     * @param {Int32Array} scores
     * @param {RecordFieldReferences} references Already admitted factory references.
     * @param {number} base
     * @returns {Uint8Array|null}
     */
    encode(count, scores, references, base) {
        if (this._memory === null || this._encode === null ||
            !Number.isSafeInteger(count) || count <= 0 || count > MAX_ROWS ||
            !Number.isSafeInteger(base) || base < 0) { return null }
        const indexes = getPrivateColumn(references.uniqueIndexList, Uint32Array.prototype)
        const scoreColumn = getPrivateColumn(scores, Int32Array.prototype)
        const offsets = getPrivateColumn(references.offsets, Float64Array.prototype)
        const lengths = getPrivateColumn(references.lengths, Uint32Array.prototype)
        if (indexes === null || scoreColumn === null || offsets === null || lengths === null ||
            indexes.length < count || scoreColumn.length < count || offsets.length !== lengths.length ||
            offsets.length <= 0 || offsets.length > MAX_UNIQUE) { return null }
        const memory = this._memory
        const currentBuffer = memory.buffer
        if (indexes.buffer === currentBuffer || scoreColumn.buffer === currentBuffer ||
            offsets.buffer === currentBuffer || lengths.buffer === currentBuffer) { return null }
        const uniqueCount = offsets.length
        const scoresPointer = this._start + count * 4
        const offsetsPointer = scoresPointer + count * 4
        const lengthsPointer = offsetsPointer + uniqueCount * 8
        const outputPointer = (lengthsPointer + uniqueCount * 4 + count * 2 + 3) & ~3
        const required = outputPointer + count * 12
        if (required > MAX_BYTES) { return null }
        try {
            const pages = Math.ceil(required / PAGE_BYTES)
            if (memory.buffer.byteLength < pages * PAGE_BYTES) { memory.grow(pages - memory.buffer.byteLength / PAGE_BYTES) }
            setTypedArray.call(new Uint32Array(memory.buffer, this._start, count), new Uint32Array(indexes.buffer, indexes.byteOffset, count))
            setTypedArray.call(new Int32Array(memory.buffer, scoresPointer, count), new Int32Array(scoreColumn.buffer, scoreColumn.byteOffset, count))
            setTypedArray.call(new Float64Array(memory.buffer, offsetsPointer, uniqueCount), new Float64Array(offsets.buffer, offsets.byteOffset, uniqueCount))
            setTypedArray.call(new Uint32Array(memory.buffer, lengthsPointer, uniqueCount), new Uint32Array(lengths.buffer, lengths.byteOffset, uniqueCount))
            const byteLength = this._encode(count, uniqueCount, base)
            if (byteLength <= 0 || byteLength >= count * 12) { return null }
            const output = new Uint8Array(byteLength)
            setTypedArray.call(output, new Uint8Array(memory.buffer, outputPointer, byteLength))
            return output
        } catch {
            // Allocation failure or a native trap cannot expose partial output.
            // Stop retrying the failed instance; this import keeps its JS path.
            this._memory = null
            this._encode = null
            return null
        }
    }
}
