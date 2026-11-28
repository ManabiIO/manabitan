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

import {RetryablePromiseCache} from '../core/retryable-promise-cache.js'

const PAGE_BYTES = 65536
const INITIAL_PAGES = 2
const MAXIMUM_PAGES = 1024
const COMPACT_MAGIC = 0x3246524d
const moduleCache = new RetryablePromiseCache()
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const typedGetters = {
    buffer: Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')?.get,
    byteOffset: Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')?.get,
    byteLength: Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')?.get,
    length: Object.getOwnPropertyDescriptor(typedPrototype, 'length')?.get,
    tag: Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)?.get,
}
const privateByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const privateResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const littleEndian = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1
const prototypes = {Uint32Array: Uint32Array.prototype, Int32Array: Int32Array.prototype, Float64Array: Float64Array.prototype}
const widths = {Uint32Array: 4, Int32Array: 4, Float64Array: 8}

/** @typedef {'Uint32Array'|'Int32Array'|'Float64Array'} ColumnKind */
/** @typedef {{buffer: ArrayBuffer, byteOffset: number, byteLength: number, length: number}} Column */
/** @typedef {{uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}} References */
/** @typedef {{rowCount: number, scoreList: number[]|Int32Array|Float64Array, fixedContentOffsetBase?: number, fixedContentLength?: number, resolvedContentReferences?: References}} RecordChunk */
/** @typedef {(chunk: RecordChunk, count: number) => References|null} PrivateReferences */
/** @typedef {{count: number, uniqueCount: number, indexes: Column, scores: Column, offsets: Column, lengths: Column}} Input */
/** @typedef {{rows: number, scores: number, offsets: number, lengths: number, slots: number, dictionary: number, keys: number, output: number, outputCapacity: number, slotCount: number, scoreCapacity: number, end: number}} Layout */
/** @typedef {(...args: number[]) => number} NativeEncode */
/** @typedef {{memory: WebAssembly.Memory, encode: NativeEncode}} NativeState */
/** @typedef {{nativeCalls: number, nativeRows: number, nativeAttempts: number, inputCopiedBytes: number, outputCopiedBytes: number, tableBytesRequested: number, memoryGrowthBytes: number, maximumLinearMemoryBytes: number, maximumScratchBytes: number, declines: Record<string, number>}} RecordFieldDiagnostics */

/**
 * Missing private-buffer or resizability intrinsics select the JavaScript path.
 * In particular, older supported Firefox versions have no resizable getter.
 * @returns {boolean}
 */
function supported() {
    return littleEndian && typeof privateByteLength === 'function' && typeof privateResizable === 'function' &&
        Object.values(typedGetters).every((getter) => typeof getter === 'function') &&
        typeof WebAssembly === 'object' && typeof WebAssembly.Module === 'function' &&
        typeof WebAssembly.compile === 'function' && typeof WebAssembly.Memory === 'function' &&
        typeof WebAssembly.Instance === 'function'
}

/**
 * Intrinsic getters establish the actual element and buffer kinds. Prototypes
 * alone would admit a differently typed view whose prototype was replaced.
 * @param {unknown} value
 * @param {ColumnKind} kind
 * @returns {Column|null}
 */
function inspectColumn(value, kind) {
    if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototypes[kind]) { return null }
    for (const key of ['buffer', 'byteOffset', 'byteLength', 'length', Symbol.toStringTag]) {
        if (Object.hasOwn(value, key)) { return null }
    }
    if (typedGetters.tag?.call(value) !== kind) { return null }
    const buffer = /** @type {ArrayBuffer} */ (typedGetters.buffer?.call(value))
    const backingBytes = privateByteLength?.call(buffer)
    if (privateResizable?.call(buffer) !== false || typeof backingBytes !== 'number') { return null }
    const length = /** @type {number} */ (typedGetters.length?.call(value))
    const byteOffset = /** @type {number} */ (typedGetters.byteOffset?.call(value))
    const byteLength = /** @type {number} */ (typedGetters.byteLength?.call(value))
    if (
        !Number.isSafeInteger(length) || !Number.isSafeInteger(byteOffset) || !Number.isSafeInteger(byteLength) ||
        length < 0 || byteOffset < 0 || byteLength !== length * widths[kind] ||
        byteOffset + byteLength > backingBytes
    ) { return null }
    return {buffer, byteOffset, byteLength, length}
}

/**
 * The factory-origin proof runs before inspecting the chunk. No cached value
 * witness is used: every current column and dimension is checked synchronously.
 * @param {RecordChunk} chunk
 * @param {number} base
 * @param {PrivateReferences} privateReferences
 * @returns {Input|null}
 */
function selectInput(chunk, base, privateReferences) {
    const references = privateReferences(chunk, 0)
    if (references === null) { return null }
    const countDescriptor = Object.getOwnPropertyDescriptor(chunk, 'rowCount')
    const scoreDescriptor = Object.getOwnPropertyDescriptor(chunk, 'scoreList')
    const fixedBase = Object.getOwnPropertyDescriptor(chunk, 'fixedContentOffsetBase')
    if (
        typeof countDescriptor === 'undefined' || !('value' in countDescriptor) ||
        typeof scoreDescriptor === 'undefined' || !('value' in scoreDescriptor) ||
        !Number.isSafeInteger(countDescriptor.value) || countDescriptor.value <= 0 || countDescriptor.value > 0xffffffff ||
        !Number.isSafeInteger(base) || base < 0 ||
        (typeof fixedBase === 'undefined' ?
            'fixedContentOffsetBase' in chunk :
            !('value' in fixedBase) || typeof fixedBase.value !== 'undefined')
    ) { return null }
    const indexes = inspectColumn(references.uniqueIndexList, 'Uint32Array')
    const scores = inspectColumn(scoreDescriptor.value, 'Int32Array')
    const offsets = inspectColumn(references.offsets, 'Float64Array')
    const lengths = inspectColumn(references.lengths, 'Uint32Array')
    const count = /** @type {number} */ (countDescriptor.value)
    if (
        indexes === null || scores === null || offsets === null || lengths === null ||
        indexes.length < count || scores.length < count || offsets.length !== lengths.length ||
        offsets.length === 0 || offsets.length > 0xffffffff
    ) { return null }
    return {count, uniqueCount: offsets.length, indexes, scores, offsets, lengths}
}

/**
 * The native stack occupies the fixed prefix; all call-owned regions follow it.
 * All byte counts are bounded before memory growth or the first input copy.
 * @param {number} count
 * @param {number} uniqueCount
 * @returns {Layout|null}
 */
function createLayout(count, uniqueCount) {
    const scoreCapacity = Math.min(count, 65535)
    let slotCount = 2
    while (slotCount < scoreCapacity * 2) { slotCount *= 2 }
    let cursor = INITIAL_PAGES * PAGE_BYTES
    /** @param {number} bytes @param {number} alignment @returns {number} */
    function allocate(bytes, alignment) {
        cursor = Math.ceil(cursor / alignment) * alignment
        const start = cursor
        cursor += bytes
        return start
    }
    const layout = {
        rows: allocate(count * 4, 4),
        scores: allocate(count * 4, 4),
        offsets: allocate(uniqueCount * 8, 8),
        lengths: allocate(uniqueCount * 4, 4),
        slots: allocate(slotCount * 4, 4),
        dictionary: allocate(scoreCapacity * 4, 4),
        keys: allocate(count * 2, 2),
        output: allocate(count * 12, 4),
        outputCapacity: count * 12,
        slotCount,
        scoreCapacity,
        end: cursor,
    }
    return Number.isSafeInteger(cursor) && cursor <= MAXIMUM_PAGES * PAGE_BYTES ? layout : null
}

/**
 * Only the immutable module is shared. Each import gets its own memory,
 * instance and counters; no caller can borrow the reusable native arena.
 */
class ImportRecordFieldEncoder {
    /** @type {NativeState|null} */
    #state

    /** @type {RecordFieldDiagnostics} */
    #diagnostics

    /** @param {NativeState} state */
    constructor(state) {
        this.#state = state
        this.#diagnostics = {
            nativeCalls: 0,
            nativeRows: 0,
            nativeAttempts: 0,
            inputCopiedBytes: 0,
            outputCopiedBytes: 0,
            tableBytesRequested: 0,
            memoryGrowthBytes: 0,
            maximumLinearMemoryBytes: state.memory.buffer.byteLength,
            maximumScratchBytes: 0,
            declines: {},
        }
    }

    /**
     * This method never invokes the stock encoder or yields. A null result lets
     * the caller execute its original JavaScript body once, outside this guard.
     * @param {RecordChunk} chunk
     * @param {number} base
     * @param {PrivateReferences} privateReferences
     * @returns {Uint8Array|null}
     */
    tryEncode(chunk, base, privateReferences) {
        const state = this.#state
        if (state === null) { return this.#decline('unavailable') }
        let input
        try {
            input = selectInput(chunk, base, privateReferences)
        } catch {
            return this.#decline('guard-exception')
        }
        if (input === null) { return this.#decline('eligibility') }
        for (const column of [input.indexes, input.scores, input.offsets, input.lengths]) {
            if (column.buffer === state.memory.buffer) { return this.#decline('native-memory-alias') }
        }
        const {count, uniqueCount} = input
        const layout = createLayout(count, uniqueCount)
        if (layout === null) { return this.#decline('memory-bound') }
        const diagnostics = this.#diagnostics
        diagnostics.maximumScratchBytes = Math.max(diagnostics.maximumScratchBytes, layout.slotCount * 4 + layout.scoreCapacity * 4 + count * 2)
        const beforeBytes = state.memory.buffer.byteLength
        const requiredPages = Math.ceil(layout.end / PAGE_BYTES)
        try {
            if (requiredPages > beforeBytes / PAGE_BYTES) {
                state.memory.grow(requiredPages - beforeBytes / PAGE_BYTES)
            }
        } catch {
            return this.#decline('memory-growth', true)
        }
        const afterBytes = state.memory.buffer.byteLength
        diagnostics.memoryGrowthBytes += afterBytes - beforeBytes
        diagnostics.maximumLinearMemoryBytes = Math.max(diagnostics.maximumLinearMemoryBytes, afterBytes)
        try {
            const bytes = new Uint8Array(state.memory.buffer)
            /** @param {Column} column @param {number} size @param {number} target */
            const copy = (column, size, target) => {
                bytes.set(new Uint8Array(column.buffer, column.byteOffset, size), target)
                diagnostics.inputCopiedBytes += size
            }
            copy(input.indexes, count * 4, layout.rows)
            copy(input.scores, count * 4, layout.scores)
            copy(input.offsets, uniqueCount * 8, layout.offsets)
            copy(input.lengths, uniqueCount * 4, layout.lengths)
        } catch {
            return this.#decline('input-copy', true)
        }
        ++diagnostics.nativeAttempts
        diagnostics.tableBytesRequested += layout.slotCount * 4
        let result
        try {
            result = state.encode(count, uniqueCount, layout.rows, layout.scores, layout.offsets, layout.lengths, base,
                layout.slots, layout.slotCount, layout.dictionary, layout.keys, layout.output, layout.outputCapacity)
        } catch {
            return this.#decline('native-trap', true)
        }
        if (result === 0) { return this.#decline('unsupported-compact') }
        if (!Number.isInteger(result) || result < 20 || result > layout.outputCapacity || result >= count * 12) {
            return this.#decline('native-return', true)
        }
        try {
            const header = new Uint32Array(state.memory.buffer, layout.output, 4)
            const scoreCount = header[2]
            if (
                header[0] !== COMPACT_MAGIC || header[1] !== count || header[3] !== 2 ||
                scoreCount === 0 || scoreCount >= 65535 || scoreCount > layout.scoreCapacity ||
                result !== 16 + scoreCount * 4 + count * 8
            ) { return this.#decline('native-header', true) }
            const output = new Uint8Array(result)
            output.set(new Uint8Array(state.memory.buffer, layout.output, result))
            ++diagnostics.nativeCalls
            diagnostics.nativeRows += count
            diagnostics.outputCopiedBytes += result
            return output
        } catch {
            return this.#decline('output-copy', true)
        }
    }

    /** @returns {void} */
    dispose() {
        this.#state = null
    }

    /** @returns {RecordFieldDiagnostics} */
    getDiagnostics() {
        return {...this.#diagnostics, declines: {...this.#diagnostics.declines}}
    }

    /**
     * @param {string} reason
     * @param {boolean} [disable]
     * @returns {null}
     */
    #decline(reason, disable = false) {
        const declines = this.#diagnostics.declines
        declines[reason] = (declines[reason] ?? 0) + 1
        if (disable) { this.dispose() }
        return null
    }
}

/**
 * Preparation is optional and belongs before the synchronous validation/encode
 * boundary. Failed fetches and compiles remain retryable for a later session.
 * @returns {Promise<ImportRecordFieldEncoder|null>}
 */
export async function createImportRecordFieldEncoder() {
    if (!supported()) { return null }
    try {
        const module = await moduleCache.get(async () => {
            const response = await fetch(new URL('../../lib/term-record-fields.wasm', import.meta.url))
            if (!response.ok) { throw new Error('Failed to load native record fields') }
            const value = await WebAssembly.compile(await response.arrayBuffer())
            const imports = WebAssembly.Module.imports(value)
            const exports = WebAssembly.Module.exports(value)
            if (
                imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory' ||
                exports.length !== 2 ||
                !exports.some((item) => item.name === 'record_fields_abi_version' && item.kind === 'function') ||
                !exports.some((item) => item.name === 'encode_record_fields' && item.kind === 'function')
            ) { throw new Error('Unexpected native record-field interface') }
            return value
        })
        const memory = new WebAssembly.Memory({initial: INITIAL_PAGES, maximum: MAXIMUM_PAGES})
        const instance = new WebAssembly.Instance(module, {env: {memory}})
        const abi = instance.exports.record_fields_abi_version
        const encode = instance.exports.encode_record_fields
        if (typeof abi !== 'function' || abi() !== 1 || typeof encode !== 'function') { return null }
        return new ImportRecordFieldEncoder({memory, encode: /** @type {NativeEncode} */ (encode)})
    } catch {
        return null
    }
}
