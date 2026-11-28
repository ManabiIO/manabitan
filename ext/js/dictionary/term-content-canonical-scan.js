/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

/* eslint-disable no-underscore-dangle -- Typed private metadata-owner ABI shared with DictionaryDatabase. */
/* eslint-disable unicorn/prefer-spread -- TypedArray.slice must return owned typed columns, never number arrays. */

import {CANONICAL_CHECKSUM_LAYOUT as checksumLayout, CANONICAL_SCAN_ABI_VERSION, CANONICAL_SCAN_LAYOUT as layout} from './term-content-canonical-layout.js';

const {MAX, PREFIX, META, IDENT, ROWS, SIGS, FLAGS, OUT, JOURNAL, EXACT} = layout;
/** @type {Promise<WebAssembly.Module>|null} */
let modulePromise = null;
/** @typedef {(base: Uint8Array, derived: Uint8Array, records: Uint8Array) => [number, number, number]|null} LookupChecksumProvider */
/** @typedef {{module: WebAssembly.Module, scan: () => number, checksum: LookupChecksumProvider|null}} CanonicalInstance */
/** @type {WeakMap<WebAssembly.Memory, CanonicalInstance>} */
const instances = new WeakMap();

/* eslint-disable @stylistic/semi */
/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsics are applied explicitly or compared by identity. */
const ChecksumUint8 = Uint8Array
const checksumUint8Prototype = ChecksumUint8.prototype
const checksumTypedPrototype = /** @type {object} */ (Object.getPrototypeOf(checksumUint8Prototype))
const checksumGetPrototypeOf = Object.getPrototypeOf
const checksumHasOwn = Object.hasOwn
const checksumDescriptor = Object.getOwnPropertyDescriptor
const checksumApply = Reflect.apply
const checksumWeakMapGet = WeakMap.prototype.get
const checksumIsView = ArrayBuffer.isView
const checksumGetBuffer = /** @type {() => ArrayBufferLike} */ (checksumDescriptor(checksumTypedPrototype, 'buffer')?.get)
const checksumGetOffset = /** @type {() => number} */ (checksumDescriptor(checksumTypedPrototype, 'byteOffset')?.get)
const checksumGetLength = /** @type {() => number} */ (checksumDescriptor(checksumTypedPrototype, 'byteLength')?.get)
const checksumGetBufferLength = /** @type {() => number} */ (checksumDescriptor(ArrayBuffer.prototype, 'byteLength')?.get)
const checksumGetResizable = checksumDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const checksumSetBytes = checksumUint8Prototype.set
const checksumGetMemoryBuffer = /** @type {() => ArrayBuffer} */ (checksumDescriptor(WebAssembly.Memory.prototype, 'buffer')?.get)
// The JS path observes these intrinsics between its three hashes/header writes.
// Do not reorder those observable operations when a realm has replaced them.
const checksumValueIntrinsics = [
    [globalThis, 'Uint8Array', ChecksumUint8],
    [globalThis, 'DataView', DataView],
    [globalThis, 'Math', Math],
    [globalThis, 'Number', Number],
    [Math, 'imul', Math.imul],
    [Number, 'isInteger', Number.isInteger],
    [DataView.prototype, 'getUint32', DataView.prototype.getUint32],
    [DataView.prototype, 'setUint32', DataView.prototype.setUint32],
]
/* eslint-enable @typescript-eslint/unbound-method */

/** @returns {boolean} */
function checksumIntrinsicsUnchanged() {
    for (let i = 0; i < checksumValueIntrinsics.length; ++i) {
        const entry = checksumValueIntrinsics[i]
        if (checksumDescriptor(entry[0], /** @type {string} */ (entry[1]))?.value !== entry[2]) { return false }
    }
    return (
        checksumGetPrototypeOf(checksumUint8Prototype) === checksumTypedPrototype &&
        !checksumHasOwn(checksumUint8Prototype, 'buffer') &&
        !checksumHasOwn(checksumUint8Prototype, 'byteOffset') &&
        !checksumHasOwn(checksumUint8Prototype, 'byteLength') &&
        checksumDescriptor(checksumTypedPrototype, 'buffer')?.get === checksumGetBuffer &&
        checksumDescriptor(checksumTypedPrototype, 'byteOffset')?.get === checksumGetOffset &&
        checksumDescriptor(checksumTypedPrototype, 'byteLength')?.get === checksumGetLength
    )
}

/**
 * @param {Uint8Array} bytes
 * @param {ArrayBuffer} nativeBuffer
 * @returns {{buffer: ArrayBuffer, offset: number, length: number}|null}
 */
function admitChecksumBytes(bytes, nativeBuffer) {
    // isView rejects proxies without invoking their prototype/metadata traps.
    if (
        !checksumIsView(bytes) || checksumGetPrototypeOf(bytes) !== checksumUint8Prototype ||
        checksumHasOwn(bytes, 'buffer') || checksumHasOwn(bytes, 'byteOffset') || checksumHasOwn(bytes, 'byteLength')
    ) { return null }
    const buffer = checksumApply(checksumGetBuffer, bytes, [])
    if (buffer === nativeBuffer) { return null }
    try {
        // This intrinsic rejects shared buffers. Resizable buffers keep JS too.
        checksumApply(checksumGetBufferLength, buffer, [])
        if (checksumGetResizable && checksumApply(checksumGetResizable, buffer, [])) { return null }
    } catch { return null }
    const length = checksumApply(checksumGetLength, bytes, [])
    if (length > 0xffffffff) { return null }
    return {
        buffer: /** @type {ArrayBuffer} */ (buffer),
        offset: checksumApply(checksumGetOffset, bytes, []),
        length,
    }
}

/**
 * Optional exports use only a disjoint tail of an already-owned fixed arena.
 * The helper stays in the memory-keyed WeakMap, never in the record store.
 * @param {WebAssembly.Exports} exports
 * @param {WebAssembly.Memory} memory
 * @returns {LookupChecksumProvider|null}
 */
function createLookupChecksum(exports, memory) {
    const names = ['xxh32_abi_version', 'xxh32_layout_end', 'xxh32_scratch_ptr', 'xxh32_scratch_capacity', 'xxh32_init', 'xxh32_update', 'xxh32_finish']
    for (let i = 0; i < names.length; ++i) {
        if (typeof exports[names[i]] !== 'function') { return null }
    }
    const native = /** @type {{xxh32_abi_version: () => number, xxh32_layout_end: () => number, xxh32_scratch_ptr: () => number, xxh32_scratch_capacity: () => number, xxh32_init: (seed: number) => void, xxh32_update: (a: number, b: number, c: number) => number, xxh32_finish: (index: number) => number}} */ (exports)
    try {
        const buffer = checksumApply(checksumGetMemoryBuffer, memory, [])
        const {SCRATCH, CAPACITY, END} = checksumLayout
        if (
            native.xxh32_abi_version() !== 1 || native.xxh32_layout_end() !== END ||
            native.xxh32_scratch_ptr() !== SCRATCH || native.xxh32_scratch_capacity() !== CAPACITY ||
            checksumApply(checksumGetBufferLength, buffer, []) < PREFIX
        ) { return null }
        const scratch0 = new ChecksumUint8(buffer, SCRATCH, CAPACITY)
        const scratch1 = new ChecksumUint8(buffer, SCRATCH + CAPACITY, CAPACITY)
        const scratch2 = new ChecksumUint8(buffer, SCRATCH + CAPACITY * 2, CAPACITY)
        let disabled = false
        return (a, b, c) => {
            if (disabled || checksumApply(checksumGetMemoryBuffer, memory, []) !== buffer || !checksumIntrinsicsUnchanged()) { return null }
            const x = admitChecksumBytes(a, buffer)
            const y = admitChecksumBytes(b, buffer)
            const z = admitChecksumBytes(c, buffer)
            if (x === null || y === null || z === null || x.length + y.length + z.length < 3072) { return null }
            try {
                // All admissions precede state mutation. No callback, await or
                // species-sensitive operation can run until all hashes finish.
                native.xxh32_init(0x811c9dc5)
                let xOffset = 0
                let yOffset = 0
                let zOffset = 0
                while (xOffset < x.length || yOffset < y.length || zOffset < z.length) {
                    const xRemaining = x.length - xOffset
                    const yRemaining = y.length - yOffset
                    const zRemaining = z.length - zOffset
                    const xCount = xRemaining < CAPACITY ? xRemaining : CAPACITY
                    const yCount = yRemaining < CAPACITY ? yRemaining : CAPACITY
                    const zCount = zRemaining < CAPACITY ? zRemaining : CAPACITY
                    if (xCount > 0) { checksumApply(checksumSetBytes, scratch0, [new ChecksumUint8(x.buffer, x.offset + xOffset, xCount)]) }
                    if (yCount > 0) { checksumApply(checksumSetBytes, scratch1, [new ChecksumUint8(y.buffer, y.offset + yOffset, yCount)]) }
                    if (zCount > 0) { checksumApply(checksumSetBytes, scratch2, [new ChecksumUint8(z.buffer, z.offset + zOffset, zCount)]) }
                    if (native.xxh32_update(xCount, yCount, zCount) !== 1) {
                        disabled = true
                        return null
                    }
                    xOffset += xCount
                    yOffset += yCount
                    zOffset += zCount
                }
                return [native.xxh32_finish(0) >>> 0, native.xxh32_finish(1) >>> 0, native.xxh32_finish(2) >>> 0]
            } catch {
                // Only private native scratch was writable. The caller can
                // safely hash the same current input through its original JS.
                disabled = true
                return null
            }
        }
    } catch { return null }
}
/* eslint-enable @stylistic/semi */

/** @returns {Promise<WebAssembly.Module>} */
export function compileCanonicalScanModule() {
    if (modulePromise === null) {
        modulePromise = (async () => {
            const response = await fetch(new URL('../../lib/term-content-canonical-scan-v1.wasm', import.meta.url));
            if (!response.ok) {
                throw new Error(`Failed to load canonical scan WASM: ${response.status}`);
            }
            return await WebAssembly.compile(await response.arrayBuffer());
        })().catch((error) => {
            modulePromise = null;
            throw error;
        });
    }
    return modulePromise;
}

/**
 * @typedef {import('./term-content-metadata-arena.js').TermContentMetadataArena} Arena
 * @typedef {import('./dictionary-database.js').TermContentMeta} TermContentMeta
 * @typedef {import('./dictionary-database.js').ArtifactTermContentDedupPlan} DedupPlan
 * @typedef {{columns: Uint32Array[], planStart: number}} PendingBatch
 * @typedef {object} ScanOwner
 * @property {number[]} _termEntryContentMetaFreeIndexes
 * @property {Arena|null} _termContentMetadataArena
 * @property {number} _termEntryContentMetaDenseCount
 * @property {number} _termEntryContentMetaHashPairPendingCount
 * @property {number} _termEntryContentMetaHashPairCount
 * @property {(count: number) => void} _ensureTermEntryContentMetaHashPairCapacity
 * @property {(index: number) => TermContentMeta|undefined} _readTermEntryContentMetaHashPairIndex
 * @typedef {object} ScanContext
 * @property {import('./dictionary-database.js').ArtifactTermContentChunk & {contentMetaList: Uint32Array, contentRowStart: number, contentBytesBaseOffset: number, contentBytesBuffer: Uint8Array}} chunk
 * @property {DedupPlan} contentDedupPlan
 * @property {Uint32Array} uniqueIndexList
 * @property {Uint32Array} uniqueRowIndexes
 * @property {Uint32Array|null|undefined} uniqueSignatures
 * @property {number} firstUniqueIndex
 * @property {number} lastUniqueIndex
 * @property {boolean} persistedLookupRequired
 * @property {boolean} reserveMetadata
 * @property {(batch: PendingBatch, complete: () => undefined) => undefined} adoptPendingColumns Copies borrowed columns synchronously before the next scan.
 * @property {() => number} getPendingCount
 * @property {(import('./dictionary-database.js').PendingContentDescriptor & {existingMeta: TermContentMeta})[]} exactCandidates
 * @property {() => Promise<void>} resolveExactCandidates
 * @typedef {object} ScanHooks Internal test-only fault dependencies; never user settings.
 * @property {number} [trapAfter]
 * @property {(state: {a: Arena, beforeDense: number, beforePending: number}) => void} [beforeNative]
 * @property {(state: {header: Uint32Array, a: Arena, column: number}) => void} [beforeOutputView]
 * @property {(state: PendingBatch & {plan: DedupPlan}) => void} [beforeAdopt]
 * @property {(state: {plan: DedupPlan, planStart: number}) => void} [afterPendingCopy]
 * @property {(state: {unique: number}) => void} [afterExactDescriptor]
 */

export const CANONICAL_SCAN_METRICS = Object.freeze({
    calls: 'dedupNativeCallCount',
    rows: 'dedupNativeScannedRows',
    nativePendingRows: 'dedupNativeBulkPendingRows',
    exactDescriptorRows: 'dedupNativeExactCandidates',
    copiedInputBytes: 'dedupNativeCopiedInputBytes',
    copiedOutputBytes: 'dedupNativeCopiedOutputBytes',
    snapshotBytes: 'dedupNativeSnapshotBytes',
    fallbacks: 'dedupNativeFallbackCount',
    fallbackEligibility: 'dedupNativeFallbackEligibilityCount',
    fallbackAsset: 'dedupNativeFallbackAssetCount',
    fallbackUnsupported: 'dedupNativeFallbackUnsupportedCount',
});

/**
 * Stateless with respect to database/arena lifetime. Compiled immutable code is
 * single-flight; instances are weakly keyed by fixed memory. Segment views
 * are copied into the pending owner before exact-byte matching can await.
 */
export class NativeCanonicalScanner {
    /** @param {{loadModule?: () => Promise<WebAssembly.Module>, hooks?: ScanHooks}} [dependencies] */
    constructor({loadModule = compileCanonicalScanModule, hooks = {}} = {}) {
        /** @type {() => Promise<WebAssembly.Module>} */
        this._loadModule = loadModule;
        /** @type {ScanHooks} */
        this._hooks = hooks;
        /** Cumulative segment counters; no database or arena references. */
        this.stats = {
            calls: 0,
            rows: 0,
            inserted: 0,
            fallbacks: 0,
            instances: 0,
            copiedInputBytes: 0,
            copiedOutputBytes: 0,
            copiedTableBytes: 0,
            copiedGlossaryBytes: 0,
            scatterRows: 0,
            nativeMissJsScatterRows: 0,
            nativePendingRows: 0,
            exactDescriptorRows: 0,
            failedExactAppendRows: 0,
            snapshotBytes: 0,
            adoptedColumnBytes: 0,
            synchronousRollbacks: 0,
            fallbackEligibility: 0,
            fallbackAsset: 0,
            fallbackUnsupported: 0,
            fallbackReason: '',
        };
    }

    /* eslint-disable @stylistic/semi */
    /**
     * Resolve the current owner at the call site; never retain an arena across
     * growth, teardown or an await. Checksumming cannot allocate an arena,
     * acquire a module, or instantiate code solely for this optional path.
     * @param {Arena|null} arena
     * @param {Uint8Array} base
     * @param {Uint8Array} derived
     * @param {Uint8Array} records
     * @returns {[number, number, number]|null}
     */
    tryHashLookupIndex(arena, base, derived, records) {
        if (arena === null) { return null }
        const cached = /** @type {CanonicalInstance|undefined} */ (checksumApply(checksumWeakMapGet, instances, [arena.memory]))
        return cached?.checksum?.(base, derived, records) ?? null
    }
    /* eslint-enable @stylistic/semi */

    /**
     * @param {ScanOwner} db
     * @param {ScanContext} ctx
     * @param {Record<string, number>} metrics
     * @returns {Promise<number|null>}
     */
    async scan(db, ctx, metrics) {
        const before = {...this.stats};
        try {
            return await this._scan(db, ctx);
        } finally {
            for (const [counter, key] of Object.entries(CANONICAL_SCAN_METRICS)) {
                const name = /** @type {keyof typeof CANONICAL_SCAN_METRICS} */ (counter);
                metrics[key] = this.stats[name] - before[name];
            }
        }
    }

    /**
     * @param {ScanOwner} db
     * @param {ScanContext} ctx
     * @returns {Promise<number|null>}
     * @throws {Error} Native or exact failures after mutation must reach outer rollback.
     */
    async _scan(db, ctx) {
        const stats = this.stats;
        const {
            chunk,
            contentDedupPlan: plan,
            uniqueIndexList,
            uniqueRowIndexes,
            uniqueSignatures,
            firstUniqueIndex: first,
            lastUniqueIndex: last,
            persistedLookupRequired,
            reserveMetadata,
            adoptPendingColumns,
            getPendingCount,
            exactCandidates,
            resolveExactCandidates,
        } = ctx;
        const n = last - first,
            count = chunk.rowCount;
        const uniqueMetadata = chunk.contentMetaByUniqueIndex === true;
        const inputRowCount = uniqueMetadata ? n : count;
        const inputRowStart = uniqueMetadata ? first : chunk.contentRowStart;
        /**
         * @param {number} x
         * @returns {boolean}
         */
        const safe32 = (x) => Number.isSafeInteger(x) && x >= 0 && x <= 0xffffffff;
        if (
            !safe32(count) ||
            !safe32(first) ||
            !safe32(last) ||
            count > MAX ||
            n > MAX ||
            !(uniqueSignatures instanceof Uint32Array) ||
            !safe32(chunk.contentRowStart) ||
            !safe32(chunk.contentBytesBaseOffset) ||
            !safe32(chunk.contentBytesBuffer.byteLength) ||
            Array.isArray(chunk.contentDictNameList) ||
            typeof chunk.uniformContentDictName !== 'string' ||
            chunk.uniformContentDictName.length === 0 ||
            (
                !(plan.pendingEpochs === null && plan.pendingIndexes === null) &&
                (
                    !(plan.pendingEpochs instanceof Uint32Array) || plan.pendingEpochs.length < last ||
                    !(plan.pendingIndexes instanceof Uint32Array) || plan.pendingIndexes.length < last
                )
            ) ||
            uniqueSignatures.length < last * 3 ||
            db._termEntryContentMetaFreeIndexes.length > 0 ||
            (db._termContentMetadataArena !== null && db._termContentMetadataArena.slots.byteOffset < PREFIX)
        ) {
            ++stats.fallbacks;
            ++stats.fallbackEligibility;
            stats.fallbackReason = 'eligibility';
            return null;
        }
        let module;
        try {
            module = await this._loadModule();
        } catch {
            ++stats.fallbacks;
            ++stats.fallbackAsset;
            stats.fallbackReason = 'asset';
            return null;
        }
        if (!db._termContentMetadataArena) {
            db._ensureTermEntryContentMetaHashPairCapacity(1);
        }
        let cursor = 0,
            resolved = 0,
            inputArena = null;
        while (cursor < n) {
            // Every await can replace the arena and change the pending base. No borrowed
            // WASM view survives a segment. Each memory generation has fixed size.
            const a = db._termContentMetadataArena;
            if (db._termEntryContentMetaFreeIndexes.length > 0) {
                throw new Error('Free IDs appeared during native canonical scan');
            }
            if (a === null) {
                throw new Error('Missing canonical metadata arena');
            }
            let native;
            try {
                let cached = instances.get(a.memory);
                if (typeof cached === 'undefined' || cached.module !== module) {
                    const exports = new WebAssembly.Instance(module, {env: {memory: a.memory}}).exports;
                    if (
                        typeof exports.scan_canonical !== 'function' ||
                        typeof exports.canonical_abi_version !== 'function' ||
                        exports.canonical_abi_version() !== CANONICAL_SCAN_ABI_VERSION ||
                        typeof exports.canonical_layout_end !== 'function' ||
                        exports.canonical_layout_end() !== layout.usedBytes ||
                        typeof exports.canonical_max_rows !== 'function' ||
                        exports.canonical_max_rows() !== MAX ||
                        typeof exports.canonical_prefix_bytes !== 'function' ||
                        exports.canonical_prefix_bytes() !== PREFIX
                    ) {
                        throw new Error('Canonical scan WASM ABI/layout mismatch');
                    }
                    cached = {
                        module,
                        scan: /** @type {() => number} */ (exports.scan_canonical),
                        checksum: createLookupChecksum(exports, a.memory),
                    };
                    instances.set(a.memory, cached);
                    ++stats.instances;
                }
                native = cached.scan;
            } catch (error) {
                if (cursor !== 0) {
                    throw error;
                }
                ++stats.fallbacks;
                ++stats.fallbackUnsupported;
                stats.fallbackReason = 'unsupported-or-abi';
                return null;
            }
            const buffer = a.memory.buffer;
            if (inputArena !== a) {
                if (uniqueMetadata) {
                    new Uint32Array(buffer, META, n * 4).set(chunk.contentMetaList.subarray(first * 4, last * 4));
                    const identities = new Uint32Array(buffer, IDENT, n);
                    const rows = new Uint32Array(buffer, ROWS, n);
                    for (let i = 0; i < n; ++i) {
                        const unique = first + i;
                        const row = uniqueRowIndexes[unique] - chunk.contentRowStart;
                        const validRow = row >= 0 && row < count;
                        rows[i] = validRow ? unique : last;
                        // Preserve native validation order, including the exact
                        // comparison await boundary. Invalid source identities
                        // fail when the scanner reaches that representative.
                        identities[i] = validRow && uniqueIndexList[row] === unique ? unique : unique ^ 1;
                    }
                } else {
                    new Uint32Array(buffer, META, count * 4).set(chunk.contentMetaList.subarray(0, count * 4));
                    new Uint32Array(buffer, IDENT, count).set(uniqueIndexList.subarray(0, count));
                    new Uint32Array(buffer, ROWS, n).set(uniqueRowIndexes.subarray(first, last));
                }
                new Uint32Array(buffer, SIGS, n * 3).set(uniqueSignatures.subarray(first * 3, last * 3));
                stats.copiedInputBytes += inputRowCount * 20 + n * 16;
                inputArena = a;
            }
            new Uint8Array(buffer, FLAGS + cursor, n - cursor).set(plan.resolvedFlags.subarray(first + cursor, last));
            const planStart = first + cursor;
            stats.copiedInputBytes += n - cursor;
            const beforeDense = db._termEntryContentMetaDenseCount,
                beforePending = db._termEntryContentMetaHashPairPendingCount;
            const header = new Uint32Array(buffer, 1024, 7);
            new Uint32Array(buffer, 1088, 22).set([
                a.slots.byteOffset,
                a.slots.length,
                a.hash1.byteOffset,
                a.hash2.byteOffset,
                a.state.byteOffset,
                a.length.byteOffset,
                a.signaturePresent.byteOffset,
                a.signature1.byteOffset,
                a.signature2.byteOffset,
                a.signature3.byteOffset,
                a.state.length,
                beforeDense,
                inputRowCount,
                first,
                last,
                cursor,
                inputRowStart,
                chunk.contentBytesBaseOffset,
                chunk.contentBytesBuffer.byteLength,
                persistedLookupRequired && db._termEntryContentMetaHashPairCount > 0 ? 1 : 0,
                reserveMetadata ? 1 : 0,
                this._hooks.trapAfter ?? 0,
            ]);
            const exactBase = exactCandidates.length;
            this._hooks.beforeNative?.({a, beforeDense, beforePending});
            try {
                ++stats.calls;
                const stop = native();
                if (stop < 0) {
                    throw new Error(`Native canonical scan error ${stop}`);
                }
                // The pending owner copies these views before we await exact matching
                // or let another scan reuse the native scratch.
                /** @type {Uint32Array[]} */
                const columns = [];
                for (let column = 0; column < 6; ++column) {
                    this._hooks.beforeOutputView?.({header, a, column});
                    columns.push(new Uint32Array(buffer, OUT + column * MAX * 4, header[2]));
                }
                const exact = new Uint32Array(buffer, EXACT, header[3] * 2).slice();
                const next = header[1],
                    segmentResolved = header[4],
                    nextDense = header[5],
                    inserted = header[0];
                stats.copiedOutputBytes += exact.byteLength;
                db._termEntryContentMetaDenseCount = nextDense;
                db._termEntryContentMetaHashPairPendingCount = beforePending + inserted;
                this._hooks.beforeAdopt?.({columns, planStart, plan});
                adoptPendingColumns({columns, planStart}, () => {
                    this._hooks.afterPendingCopy?.({plan, planStart});
                    // Bounded published candidates still use the original exact byte matcher.
                    for (let i = 0; i < exact.length; i += 2) {
                        const unique = first + exact[i],
                            row = uniqueRowIndexes[unique] - chunk.contentRowStart,
                            m = (uniqueMetadata ? unique : row) * 4;
                        const existingMeta = db._readTermEntryContentMetaHashPairIndex(exact[i + 1]);
                        if (typeof existingMeta === 'undefined') {
                            throw new Error('Invalid canonical exact descriptor');
                        }
                        exactCandidates.push({
                            uniqueIndex: unique,
                            rowIndex: row,
                            contentOffset: chunk.contentBytesBaseOffset + chunk.contentMetaList[m],
                            contentLength: chunk.contentMetaList[m + 1],
                            hash1: chunk.contentMetaList[m + 2],
                            hash2: chunk.contentMetaList[m + 3],
                            existingMeta,
                        });
                        this._hooks.afterExactDescriptor?.({unique});
                    }
                });
                stats.exactDescriptorRows += exact.length / 2;
                stats.nativePendingRows += header[2];
                stats.adoptedColumnBytes += header[2] * (reserveMetadata ? 24 : 20);
                stats.rows += next - cursor;
                stats.inserted += inserted;
                resolved += segmentResolved;
                cursor = next;
            } catch (error) {
                // Only this unaccepted synchronous segment may rewind its new dense suffix.
                const journal = new Uint32Array(buffer, JOURNAL, header[0] * 3);
                for (let j = header[0] - 1; j >= 0; --j) {
                    const slot = journal[j * 3],
                        previous = journal[j * 3 + 1],
                        index = journal[j * 3 + 2];
                    a.slots[slot] = previous;
                    a.state[index] = 0;
                    a.hash1[index] = a.hash2[index] = a.length[index] = 0;
                    a.signaturePresent[index] = a.signature1[index] = a.signature2[index] = a.signature3[index] = 0;
                }
                exactCandidates.length = exactBase;
                db._termEntryContentMetaDenseCount = beforeDense;
                db._termEntryContentMetaHashPairPendingCount = beforePending;
                ++stats.synchronousRollbacks;
                throw error;
            }
            const beforeExact = getPendingCount();
            await resolveExactCandidates(); // Accepted IDs belong to ordinary outer rollback.
            stats.failedExactAppendRows += getPendingCount() - beforeExact;
        }
        return resolved;
    }
}

/* eslint-enable no-underscore-dangle */
/* eslint-enable unicorn/prefer-spread */
