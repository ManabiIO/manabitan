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

import {safePerformance} from '../core/safe-performance.js';

/** @typedef {{uniqueIndexList: Uint32Array, offsets: Float64Array, lengths: Uint32Array}} References */
/** @typedef {{rowCount: number, scoreList: number[]|Int32Array|Float64Array, fixedContentOffsetBase?: number, fixedContentLength?: number, resolvedContentReferences?: References}} Chunk */
/** @typedef {(rows: number, uniqueCount: number, base: number, scores: number, ids: number, offsets: number, lengths: number, slots: number, slotCount: number, palette: number, keys: number, output: number, capacity: number) => number} NativeEncode */
/** @typedef {{heap: Uint8Array, encode: NativeEncode}} EncoderState */

const MEMORY_BYTES = 4 * 1024 * 1024;
const SCRATCH_START = 128 * 1024;
const MAX_ROWS = 65534;
const descriptor = Object.getOwnPropertyDescriptor;
const prototypeOf = Object.getPrototypeOf;
const hasOwn = Object.hasOwn;
const isView = ArrayBuffer.isView;
const typedArrayPrototype = /** @type {object} */ (prototypeOf(Uint8Array.prototype));
const typedBuffer = /** @type {(this: ArrayBufferView) => ArrayBuffer} */ (descriptor(typedArrayPrototype, 'buffer')?.get);
const typedByteOffset = /** @type {(this: ArrayBufferView) => number} */ (descriptor(typedArrayPrototype, 'byteOffset')?.get);
const typedLength = /** @type {(this: ArrayBufferView) => number} */ (descriptor(typedArrayPrototype, 'length')?.get);
const arrayBufferLength = /** @type {(this: ArrayBuffer) => number} */ (descriptor(ArrayBuffer.prototype, 'byteLength')?.get);
const columnConstructors = [Int32Array, Uint32Array, Float64Array];
const typedArrayConstructor = /** @type {object} */ (prototypeOf(Int32Array));

/** @returns {boolean} */
function hasCanonicalViewAccessors() {
    if (
        descriptor(typedArrayPrototype, 'buffer')?.get !== typedBuffer ||
        descriptor(typedArrayPrototype, 'length')?.get !== typedLength ||
        hasOwn(ArrayBuffer, Symbol.hasInstance) ||
        prototypeOf(ArrayBuffer) !== Function.prototype ||
        prototypeOf(typedArrayConstructor) !== Function.prototype ||
        hasOwn(typedArrayConstructor, Symbol.hasInstance)
    ) { return false; }
    for (const constructor of columnConstructors) {
        const prototype = constructor.prototype;
        if (
            prototypeOf(constructor) !== typedArrayConstructor ||
            prototypeOf(prototype) !== typedArrayPrototype ||
            hasOwn(prototype, 'buffer') || hasOwn(prototype, 'length') ||
            hasOwn(constructor, Symbol.hasInstance)
        ) { return false; }
    }
    return true;
}

/**
 * @param {object} object
 * @param {string} name
 * @returns {unknown}
 */
function ownData(object, name) {
    const value = descriptor(object, name);
    return typeof value !== 'undefined' && hasOwn(value, 'value') ? value.value : void 0;
}

/**
 * @param {Chunk} chunk
 * @returns {boolean}
 */
function hasUnusedPlainFixedSpan(chunk) {
    const length = descriptor(chunk, 'fixedContentLength');
    if (
        typeof length === 'undefined' ? 'fixedContentLength' in chunk :
            !hasOwn(length, 'value') || typeof length.value === 'number'
    ) { return false; }
    const offset = descriptor(chunk, 'fixedContentOffsetBase');
    return typeof offset === 'undefined' ? !('fixedContentOffsetBase' in chunk) : hasOwn(offset, 'value');
}

/**
 * @param {unknown} column
 * @param {object} expectedPrototype
 * @param {ArrayBufferLike} scratchBuffer
 * @returns {{buffer: ArrayBuffer, byteOffset: number, length: number}|null}
 */
function viewGeometry(column, expectedPrototype, scratchBuffer) {
    // Test the internal typed-array identity before prototype/instanceof work.
    // Proxies, including proxies of typed arrays, fail without running traps.
    if (
        !isView(column) || prototypeOf(column) !== expectedPrototype ||
        hasOwn(column, 'length') || hasOwn(column, 'buffer')
    ) { return null; }
    try {
        const buffer = typedBuffer.call(column);
        // The builtin getter excludes SharedArrayBuffer irrespective of its
        // prototype. A plain prototype also prevents baseline instanceof from
        // walking a caller-controlled prototype Proxy.
        arrayBufferLength.call(buffer);
        if (prototypeOf(buffer) !== ArrayBuffer.prototype || buffer === scratchBuffer) { return null; }
        return {
            buffer,
            byteOffset: typedByteOffset.call(column),
            length: typedLength.call(column),
        };
    } catch {
        // Detached, shared, or otherwise incompatible storage keeps JS behavior.
        return null;
    }
}

/** @type {Promise<WebAssembly.Module>|null} */
let modulePromise = null;

/** @returns {Promise<WebAssembly.Module>} */
export function compileRecordFieldModule() {
    if (modulePromise === null) {
        modulePromise = (async () => {
            const response = await fetch(new URL('../../lib/term-record-fields-v1.wasm', import.meta.url));
            if (!response.ok) { throw new Error('Failed to load native record-field encoder'); }
            return await WebAssembly.compile(await response.arrayBuffer());
        })().catch((error) => {
            modulePromise = null;
            throw error;
        });
    }
    return modulePromise;
}

/** @returns {{calls: number, successes: number, fallbacks: number, rows: number, copiedInputBytes: number, copiedOutputBytes: number, peakLayoutBytes: number, memoryBytes: number, peakMemoryBytes: number, initializationMs: number, assetFailures: number, releases: number}} */
function createStats() {
    return {
        calls: 0,
        successes: 0,
        fallbacks: 0,
        rows: 0,
        copiedInputBytes: 0,
        copiedOutputBytes: 0,
        peakLayoutBytes: 0,
        memoryBytes: 0,
        peakMemoryBytes: 0,
        initializationMs: 0,
        assetFailures: 0,
        releases: 0,
    };
}

/**
 * One bounded, private scratch owner per import session. Only immutable compiled
 * code is shared. Preparation happens during import setup, before row admission;
 * copies and encoding remain synchronous after the existing factory selector.
 */
export class NativeRecordFieldEncoder {
    /** @param {{loadModule?: () => Promise<WebAssembly.Module>}} [dependencies] */
    constructor({loadModule = compileRecordFieldModule} = {}) {
        this._loadModule = loadModule;
        /** @type {EncoderState|null} */
        this._state = null;
        /** @type {Promise<boolean>|null} */
        this._preparePromise = null;
        this._generation = 0;
        this._attempted = false;
        this.stats = createStats();
    }

    /** @returns {Promise<boolean>} */
    async prepare() {
        if (this._state !== null) { return true; }
        if (this._attempted) { return this._preparePromise === null ? false : await this._preparePromise; }
        this._attempted = true;
        const generation = this._generation;
        const stats = this.stats = createStats();
        const start = safePerformance.now();
        const pending = (async () => {
            try {
                const module = await this._loadModule();
                if (generation !== this._generation) { return false; }
                const imports = WebAssembly.Module.imports(module);
                if (
                    imports.length !== 1 || imports[0].module !== 'env' ||
                    imports[0].name !== 'memory' || imports[0].kind !== 'memory'
                ) { throw new Error('Unexpected record-field WASM imports'); }
                const memory = new WebAssembly.Memory({initial: MEMORY_BYTES / 65536, maximum: MEMORY_BYTES / 65536});
                stats.peakMemoryBytes = memory.buffer.byteLength;
                const instance = new WebAssembly.Instance(module, {env: {memory}});
                const {record_field_abi_version: version, encode_compact_record_fields: encode} = instance.exports;
                if (typeof version !== 'function' || version() !== 1 || typeof encode !== 'function') {
                    throw new Error('Unexpected record-field WASM ABI');
                }
                this._state = {heap: new Uint8Array(memory.buffer), encode: /** @type {NativeEncode} */ (encode)};
                stats.memoryBytes = memory.buffer.byteLength;
                return true;
            } catch {
                if (generation === this._generation) { ++stats.assetFailures; }
                return false;
            } finally {
                stats.initializationMs = safePerformance.now() - start;
                if (generation === this._generation) { this._preparePromise = null; }
            }
        })();
        this._preparePromise = pending;
        return await pending;
    }

    /** Releases every live scratch reference and invalidates late preparation. */
    release() {
        ++this._generation;
        this._state = null;
        this._preparePromise = null;
        this._attempted = false;
        this.stats.memoryBytes = 0;
        ++this.stats.releases;
    }

    /** @returns {Record<string, number>} */
    getMetrics() {
        const stats = this.stats;
        return {
            termRecordNativeFieldCalls: stats.calls,
            termRecordNativeFieldSuccesses: stats.successes,
            termRecordNativeFieldFallbacks: stats.fallbacks,
            termRecordNativeFieldRows: stats.rows,
            termRecordNativeFieldCopiedInputBytes: stats.copiedInputBytes,
            termRecordNativeFieldCopiedOutputBytes: stats.copiedOutputBytes,
            termRecordNativeFieldPeakLayoutBytes: stats.peakLayoutBytes,
            termRecordNativeFieldMemoryBytes: stats.memoryBytes,
            termRecordNativeFieldPeakMemoryBytes: stats.peakMemoryBytes,
            termRecordNativeFieldInitializationMs: stats.initializationMs,
            termRecordNativeFieldAssetFailures: stats.assetFailures,
            termRecordNativeFieldReleases: stats.releases,
        };
    }

    /** @returns {null} */
    _fallback() {
        ++this.stats.fallbacks;
        return null;
    }

    /** Disables a failed native instance for the remainder of this session. */
    _disable() {
        this._state = null;
        this.stats.memoryBytes = 0;
        ++this.stats.assetFailures;
    }

    /**
     * The caller must supply the existing synchronous selector's result and the
     * original references from the store's private factory WeakMap. The helper
     * checks current descriptors and values; no witness survives an await.
     * @param {Chunk} chunk
     * @param {number} count
     * @param {References} selected
     * @param {References|undefined} origin
     * @param {number} contentOffsetBase
     * @returns {Uint8Array|null}
     */
    tryEncode(chunk, count, selected, origin, contentOffsetBase) {
        const stats = this.stats;
        ++stats.calls;
        const state = this._state;
        if (state === null || typeof origin === 'undefined') { return this._fallback(); }
        const {heap, encode} = state;
        if (
            prototypeOf(chunk) !== Object.prototype ||
            ownData(chunk, 'resolvedContentReferences') !== origin ||
            prototypeOf(origin) !== Object.prototype || !hasUnusedPlainFixedSpan(chunk) ||
            !hasCanonicalViewAccessors()
        ) { return this._fallback(); }
        const rows = /** @type {number} */ (ownData(chunk, 'rowCount'));
        if (
            !Number.isSafeInteger(rows) || rows !== count || rows <= 0 || rows > MAX_ROWS ||
            !Number.isSafeInteger(contentOffsetBase) || contentOffsetBase < 0
        ) { return this._fallback(); }
        const scores = ownData(chunk, 'scoreList');
        const uniqueIds = ownData(origin, 'uniqueIndexList');
        const offsets = ownData(origin, 'offsets');
        const lengths = ownData(origin, 'lengths');
        const scoreGeometry = viewGeometry(scores, Int32Array.prototype, heap.buffer);
        const idGeometry = viewGeometry(uniqueIds, Uint32Array.prototype, heap.buffer);
        const offsetGeometry = viewGeometry(offsets, Float64Array.prototype, heap.buffer);
        const lengthGeometry = viewGeometry(lengths, Uint32Array.prototype, heap.buffer);
        if (
            scoreGeometry === null || idGeometry === null ||
            offsetGeometry === null || lengthGeometry === null ||
            scoreGeometry.length < rows || idGeometry.length < rows ||
            offsetGeometry.length !== lengthGeometry.length || offsetGeometry.length === 0
        ) { return this._fallback(); }
        // The store's existing selector ran once immediately before this call.
        // Recheck its snapshot against the private origin without rereading any
        // user-controlled getter or invoking the selector a second time.
        if (
            selected.uniqueIndexList !== uniqueIds ||
            selected.offsets !== offsets || selected.lengths !== lengths
        ) { return this._fallback(); }
        const uniqueCount = offsetGeometry.length;
        let slotCount = 1;
        while (slotCount < rows * 2) { slotCount *= 2; }

        // Copy only N row values, but the complete bounded U reference columns:
        // IDs may select any U entry, including inherited split-run capacity.
        let cursor = SCRATCH_START;
        /**
         * @param {number} bytes
         * @returns {number}
         */
        function allocate(bytes) {
            cursor = Math.ceil(cursor / 8) * 8;
            const pointer = cursor;
            cursor += bytes;
            return pointer;
        }
        const scorePointer = allocate(rows * 4);
        const idPointer = allocate(rows * 4);
        const offsetPointer = allocate(uniqueCount * 8);
        const lengthPointer = allocate(uniqueCount * 4);
        const slotPointer = allocate(slotCount * 4);
        const palettePointer = allocate(rows * 4);
        const keyPointer = allocate(rows * 2);
        const outputCapacity = rows * 12;
        const outputPointer = allocate(outputCapacity);
        if (cursor > MEMORY_BYTES) { return this._fallback(); }
        stats.peakLayoutBytes = Math.max(stats.peakLayoutBytes, cursor);
        heap.set(new Uint8Array(scoreGeometry.buffer, scoreGeometry.byteOffset, rows * 4), scorePointer);
        heap.set(new Uint8Array(idGeometry.buffer, idGeometry.byteOffset, rows * 4), idPointer);
        heap.set(new Uint8Array(offsetGeometry.buffer, offsetGeometry.byteOffset, uniqueCount * 8), offsetPointer);
        heap.set(new Uint8Array(lengthGeometry.buffer, lengthGeometry.byteOffset, uniqueCount * 4), lengthPointer);
        stats.copiedInputBytes += rows * 8 + uniqueCount * 12;
        let outputBytes;
        try {
            outputBytes = encode(
                rows, uniqueCount, contentOffsetBase,
                scorePointer, idPointer, offsetPointer, lengthPointer,
                slotPointer, slotCount, palettePointer, keyPointer,
                outputPointer, outputCapacity,
            );
        } catch {
            this._disable();
            return this._fallback();
        }
        if (outputBytes === 0) { return this._fallback(); }
        if (
            !Number.isInteger(outputBytes) || outputBytes < 16 ||
            outputBytes >= outputCapacity || outputPointer + outputBytes > cursor
        ) {
            this._disable();
            return this._fallback();
        }
        const output = new Uint8Array(outputBytes);
        output.set(new Uint8Array(heap.buffer, outputPointer, outputBytes));
        stats.copiedOutputBytes += outputBytes;
        ++stats.successes;
        stats.rows += rows;
        return output;
    }
}
