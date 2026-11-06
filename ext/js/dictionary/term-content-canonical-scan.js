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

import {CANONICAL_SCAN_ABI_VERSION, CANONICAL_SCAN_LAYOUT as layout} from './term-content-canonical-layout.js';

const {MAX, PREFIX, META, IDENT, ROWS, SIGS, FLAGS, OUT, JOURNAL, EXACT, EPOCHS, INDEXES} = layout;
/** @type {Promise<WebAssembly.Module>|null} */
let modulePromise = null;
/** @type {WeakMap<WebAssembly.Memory, {module: WebAssembly.Module, scan: () => number}>} */
const instances = new WeakMap();

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
 * @typedef {{columns: Uint32Array[], epochs: Uint32Array, indexes: Uint32Array, planStart: number}} PendingBatch
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
 * @property {(batch: PendingBatch, complete: () => void) => void} adoptPendingColumns
 * @property {() => {pendingBase: number, pendingEpoch: number}} getPendingState
 * @property {(import('./dictionary-database.js').PendingContentDescriptor & {existingMeta: TermContentMeta})[]} exactCandidates
 * @property {() => Promise<void>} resolveExactCandidates
 * @typedef {object} ScanHooks Internal test-only fault dependencies; never user settings.
 * @property {number} [trapAfter]
 * @property {(state: {a: Arena, beforeDense: number, beforePending: number}) => void} [beforeNative]
 * @property {(state: {header: Uint32Array, a: Arena, column: number}) => void} [beforeOutputCopy]
 * @property {(state: PendingBatch & {plan: DedupPlan}) => void} [beforeAdopt]
 * @property {(state: {plan: DedupPlan, planStart: number}) => void} [afterPlanWrite]
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
 * single-flight; instances are weakly keyed by fixed memory. Segment outputs
 * and original plan slices are owned before exact-byte matching can await.
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
            adoptedPlanBytes: 0,
            synchronousRollbacks: 0,
            fallbackEligibility: 0,
            fallbackAsset: 0,
            fallbackUnsupported: 0,
            fallbackReason: '',
        };
    }

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
            getPendingState,
            exactCandidates,
            resolveExactCandidates,
        } = ctx;
        const n = last - first,
            count = chunk.rowCount;
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
            plan.pendingEpochs.length < last ||
            plan.pendingIndexes.length < last ||
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
                    cached = {module, scan: /** @type {() => number} */ (exports.scan_canonical)};
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
                new Uint32Array(buffer, META, count * 4).set(chunk.contentMetaList.subarray(0, count * 4));
                new Uint32Array(buffer, IDENT, count).set(uniqueIndexList.subarray(0, count));
                new Uint32Array(buffer, ROWS, n).set(uniqueRowIndexes.subarray(first, last));
                new Uint32Array(buffer, SIGS, n * 3).set(uniqueSignatures.subarray(first * 3, last * 3));
                stats.copiedInputBytes += count * 20 + n * 16;
                inputArena = a;
            }
            new Uint8Array(buffer, FLAGS + cursor, n - cursor).set(plan.resolvedFlags.subarray(first + cursor, last));
            // Bounded, segment-owned original JS slices: precise restoration even if a
            // trap, output copy, partial typed set, or exact descriptor construction fails.
            const planStart = first + cursor;
            const previousEpochs = plan.pendingEpochs.slice(planStart, last);
            const previousIndexes = plan.pendingIndexes.slice(planStart, last);
            stats.snapshotBytes += previousEpochs.byteLength + previousIndexes.byteLength;
            new Uint32Array(buffer, EPOCHS + cursor * 4, n - cursor).set(previousEpochs);
            new Uint32Array(buffer, INDEXES + cursor * 4, n - cursor).set(previousIndexes);
            stats.copiedInputBytes += (n - cursor) * 9;
            const {pendingBase, pendingEpoch} = getPendingState();
            const beforeDense = db._termEntryContentMetaDenseCount,
                beforePending = db._termEntryContentMetaHashPairPendingCount;
            const header = new Uint32Array(buffer, 1024, 7);
            new Uint32Array(buffer, 1088, 24).set([
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
                count,
                first,
                last,
                cursor,
                chunk.contentRowStart,
                chunk.contentBytesBaseOffset,
                chunk.contentBytesBuffer.byteLength,
                persistedLookupRequired && db._termEntryContentMetaHashPairCount > 0 ? 1 : 0,
                reserveMetadata ? 1 : 0,
                this._hooks.trapAfter ?? 0,
                pendingBase,
                pendingEpoch,
            ]);
            const exactBase = exactCandidates.length;
            this._hooks.beforeNative?.({a, beforeDense, beforePending});
            try {
                ++stats.calls;
                const stop = native();
                if (stop < 0) {
                    throw new Error(`Native canonical scan error ${stop}`);
                }
                // Six constant-count copies, never a JS per-pending loop/scatter. Own all
                // outputs, including plan projections, before entering the exact await.
                /** @type {Uint32Array[]} */
                const columns = [];
                for (let column = 0; column < 6; ++column) {
                    this._hooks.beforeOutputCopy?.({header, a, column});
                    columns.push(new Uint32Array(buffer, OUT + column * MAX * 4, header[2]).slice());
                    stats.copiedOutputBytes += columns[column].byteLength;
                }
                const exact = new Uint32Array(buffer, EXACT, header[3] * 2).slice();
                const next = header[1],
                    segmentResolved = header[4],
                    nextDense = header[5],
                    inserted = header[0];
                const epochs = new Uint32Array(buffer, EPOCHS + cursor * 4, next - cursor).slice();
                const indexes = new Uint32Array(buffer, INDEXES + cursor * 4, next - cursor).slice();
                stats.copiedOutputBytes += exact.byteLength + epochs.byteLength + indexes.byteLength;
                db._termEntryContentMetaDenseCount = nextDense;
                db._termEntryContentMetaHashPairPendingCount = beforePending + inserted;
                this._hooks.beforeAdopt?.({columns, epochs, indexes, planStart, plan});
                adoptPendingColumns({columns, epochs, indexes, planStart}, () => {
                    this._hooks.afterPlanWrite?.({plan, planStart});
                    // Bounded published candidates still use the original exact byte matcher.
                    for (let i = 0; i < exact.length; i += 2) {
                        const unique = first + exact[i],
                            row = uniqueRowIndexes[unique] - chunk.contentRowStart,
                            m = row * 4;
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
                stats.adoptedPlanBytes += (next - cursor) * 8;
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
                plan.pendingEpochs.set(previousEpochs, planStart);
                plan.pendingIndexes.set(previousIndexes, planStart);
                exactCandidates.length = exactBase;
                db._termEntryContentMetaDenseCount = beforeDense;
                db._termEntryContentMetaHashPairPendingCount = beforePending;
                ++stats.synchronousRollbacks;
                throw error;
            }
            const beforeExact = getPendingState().pendingBase;
            await resolveExactCandidates(); // Accepted IDs belong to ordinary outer rollback.
            stats.failedExactAppendRows += getPendingState().pendingBase - beforeExact;
        }
        return resolved;
    }
}

/* eslint-enable no-underscore-dangle */
/* eslint-enable unicorn/prefer-spread */
