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

/**
 * @typedef {Omit<Parameters<import('./term-record-opfs-store.js').TermRecordOpfsStore['appendBatchFromArtifactChunkResolvedContent']>[0], 'dictionary'|'preparedLookupIndexes'> & {
 *   dictionary?: string,
 *   dictionaryTotalRows?: number,
 *   contentRowStart?: number,
 *   contentUniqueIndexList?: Uint32Array|null,
 *   contentDedupPlan?: {sourceRowCount?: number, uniqueCount?: number}|null,
 *   releaseBorrowedContent?: () => void,
 *   preparedLookupIndexes?: Map<string, import('./term-lookup-index-preparation.js').PreparedTermLookupIndex>,
 * }} NativeRecordColumns
 */
/** @typedef {NonNullable<ReturnType<typeof captureRecordColumns>>} RecordColumns */
/** @typedef {{owner: NativeTermRecordImportOwner, target: object, columns: RecordColumns, dictionary: string|undefined, dictionaryTotalRows: number|undefined, claimed: boolean, admitted: boolean, active: boolean}} RecordLeaseState */

/** @type {WeakMap<object, RecordColumns>} */
const receivedNativeRecords = new WeakMap();
/** @type {WeakMap<object, RecordLeaseState>} */
const recordLeases = new WeakMap();

/**
 * Fixed private buffers are transferred out of the parser worker. Shared and
 * resizable views cannot establish this record-column ownership contract.
 * @param {ArrayBufferView} view
 * @returns {boolean}
 */
function hasPrivateBacking(view) {
    return view.buffer instanceof ArrayBuffer && view.buffer.byteLength > 0 &&
    Reflect.get(view.buffer, 'resizable') !== true;
}

/**
 * This is a descriptor of a trusted receiver result, not a proof obtainable
 * from arbitrary caller shapes. The receiver and private importer establish
 * exclusive ownership; the descriptor detects replaced columns and wrappers.
 * Ordinary database and record-store admission still validate the complete
 * prepared index and key geometry. Ownership checks need no extra key scan.
 * @param {unknown} value
 * @returns {object|null}
 */
function captureRecordColumns(value) {
    if (typeof value !== 'object' || value === null) { return null; }
    const chunk = /** @type {NativeRecordColumns} */ (value);
    const {rowCount, termRecordPreinternedPlan: plan, preparedLookupIndexes: indexes} = chunk;
    if (
        !Number.isSafeInteger(rowCount) || rowCount <= 0 || rowCount >= 0xffff ||
        (chunk.contentRowStart ?? 0) !== 0 ||
        typeof chunk.releaseBorrowedContent !== 'undefined' ||
        !Array.isArray(chunk.expressionBytesList) || chunk.expressionBytesList.length > 0 ||
        !Array.isArray(chunk.readingBytesList) || chunk.readingBytesList.length > 0 ||
        !(chunk.readingEqualsExpressionList instanceof Uint8Array) || chunk.readingEqualsExpressionList.length !== rowCount ||
        !(chunk.scoreList instanceof Int32Array || chunk.scoreList instanceof Float64Array) || chunk.scoreList.length !== rowCount ||
        !(chunk.sequenceList instanceof Int32Array || chunk.sequenceList instanceof Float64Array) || chunk.sequenceList.length !== rowCount ||
        !(chunk.contentUniqueIndexList instanceof Uint32Array) || chunk.contentUniqueIndexList.length !== rowCount ||
        chunk.contentDedupPlan?.sourceRowCount !== rowCount ||
        typeof plan !== 'object' || plan === null ||
        !(plan.stringsBuffer instanceof Uint8Array) ||
        !(plan.stringLengths instanceof Uint16Array) || plan.stringLengths.length === 0 || plan.stringLengths.length >= 0xffff ||
        !(plan.expressionIndexes instanceof Uint32Array) || plan.expressionIndexes.length !== rowCount ||
        !(plan.readingIndexes instanceof Uint32Array) || plan.readingIndexes.length !== rowCount ||
        !(indexes instanceof Map) || indexes.size !== 1
    ) { return null; }
    const prepared = indexes.get(`0:${rowCount}`);
    if (
        typeof prepared !== 'object' || prepared === null || prepared.preinternedPlan !== plan ||
        !(prepared.bytes instanceof Uint8Array) || prepared.bytes.byteLength === 0
    ) { return null; }
    const views = [
        plan.stringsBuffer,
        plan.stringLengths,
        plan.expressionIndexes,
        plan.readingIndexes,
        chunk.readingEqualsExpressionList,
        chunk.scoreList,
        chunk.sequenceList,
        chunk.contentUniqueIndexList,
        prepared.bytes,
    ];
    for (const optional of [plan.stringOffsets, plan.stringHashes, prepared.routeFilter]) {
        if (optional === null || typeof optional === 'undefined') { continue; }
        if (!(optional instanceof Uint32Array)) { return null; }
        views.push(optional);
    }
    if (!views.every(hasPrivateBacking)) { return null; }
    return {
        rowCount,
        expressionBytesList: chunk.expressionBytesList,
        readingBytesList: chunk.readingBytesList,
        readingEqualsExpressionList: chunk.readingEqualsExpressionList,
        scoreList: chunk.scoreList,
        sequenceList: chunk.sequenceList,
        contentUniqueIndexList: chunk.contentUniqueIndexList,
        contentDedupPlan: chunk.contentDedupPlan,
        sourceRowCount: chunk.contentDedupPlan.sourceRowCount,
        uniqueCount: chunk.contentDedupPlan.uniqueCount,
        plan,
        stringsBuffer: plan.stringsBuffer,
        stringLengths: plan.stringLengths,
        stringOffsets: plan.stringOffsets,
        stringHashes: plan.stringHashes,
        expressionIndexes: plan.expressionIndexes,
        readingIndexes: plan.readingIndexes,
        indexes,
        prepared,
        preparedBytes: prepared.bytes,
        routeFilter: prepared.routeFilter,
    };
}

/**
 * @param {unknown} value
 * @param {RecordColumns} expected
 * @returns {boolean}
 */
function matchesRecordColumns(value, expected) {
    const current = captureRecordColumns(value);
    if (current === null) { return false; }
    return Object.keys(expected).every((key) => Reflect.get(current, key) === Reflect.get(expected, key));
}

/**
 * Called only by the known parser-worker result receiver, after transfer.
 * A public parser callback can receive these bytes but receives no import
 * lease; generic database and resolved-reference factory calls stay mutable.
 * @param {object} chunk
 * @returns {boolean}
 */
export function registerReceivedNativeTermRecordChunk(chunk) {
    const columns = captureRecordColumns(chunk);
    if (columns === null) { return false; }
    receivedNativeRecords.set(chunk, columns);
    return true;
}

/** Owns leases only for the importer's private ordered sink callback. */
export class NativeTermRecordImportOwner {
    /** @param {() => void} validateOwner */
    constructor(validateOwner) {
        /** @type {() => void} */
        this._validateOwner = validateOwner;
        /** @type {WeakMap<object, object>} */
        this._leases = new WeakMap();
        /** @type {boolean} */
        this._closed = false;
    }

    /**
     * Rebinds the genuine receiver result across the importer's object spread.
     * This method is never called for arbitrary application onChunk callbacks.
     * @param {object} source
     * @param {object} target
     * @returns {object|null}
     */
    bind(source, target) {
        const columns = receivedNativeRecords.get(source);
        receivedNativeRecords.delete(source);
        if (
            this._closed || typeof columns === 'undefined' ||
            !matchesRecordColumns(source, columns) || !matchesRecordColumns(target, columns)
        ) { return null; }
        this.validate();
        const chunk = /** @type {NativeRecordColumns} */ (target);
        const lease = {};
        recordLeases.set(lease, {
            owner: this,
            target,
            columns,
            dictionary: chunk.dictionary,
            dictionaryTotalRows: chunk.dictionaryTotalRows,
            claimed: false,
            admitted: false,
            active: true,
        });
        this._leases.set(target, lease);
        return lease;
    }

    /**
     * A lease travels out of band into one database append, never on the chunk.
     * @param {object} target
     * @returns {object|null}
     */
    claim(target) {
        const lease = this._leases.get(target);
        this._leases.delete(target);
        if (typeof lease === 'undefined') { return null; }
        const state = recordLeases.get(lease);
        if (typeof state === 'undefined' || !state.active || this._closed) { return null; }
        this.validate();
        state.claimed = true;
        return lease;
    }

    /**
     * Dropping the lease never permits recycling bytes retained by a record
     * cache. Transferred native record buffers remain immutable after import.
     * @param {object|null} lease
     */
    release(lease) {
        if (lease === null) { return; }
        const state = recordLeases.get(lease);
        if (typeof state === 'undefined' || state.owner !== this) { return; }
        state.active = false;
        this._leases.delete(state.target);
        recordLeases.delete(lease);
    }

    /** @throws {Error} If the import no longer owns its record inputs. */
    validate() {
        if (this._closed) { throw new Error('Native term-record import ownership is closed'); }
        this._validateOwner();
    }

    /** @returns {boolean} */
    get active() { return !this._closed; }

    /** Invalidates admission synchronously without changing ordinary await order. */
    close() {
        this._closed = true;
        this._leases = new WeakMap();
    }
}

/**
 * @param {unknown} lease
 * @param {unknown} value
 * @returns {boolean}
 */
export function hasNativeTermRecordLease(lease, value) {
    if (typeof lease !== 'object' || lease === null) { return false; }
    const state = recordLeases.get(lease);
    if (typeof state === 'undefined' || !state.active || !state.claimed || !state.owner.active || state.target !== value) { return false; }
    const chunk = /** @type {NativeRecordColumns} */ (value);
    return chunk.dictionary === state.dictionary && chunk.dictionaryTotalRows === state.dictionaryTotalRows &&
    matchesRecordColumns(value, state.columns);
}

/**
 * @param {object} lease
 * @param {unknown} chunk
 * @throws {Error} If the private input lifetime or import owner changed.
 */
export function assertNativeTermRecordLease(lease, chunk) {
    if (!hasNativeTermRecordLease(lease, chunk)) { throw new Error('Native term-record input ownership changed'); }
    const state = /** @type {RecordLeaseState} */ (recordLeases.get(lease));
    state.owner.validate();
}

/**
 * Consumes database admission once, while retaining the input lifetime for
 * every content and record await owned by that append.
 * @param {object} lease
 * @param {unknown} chunk
 * @throws {Error} If this lease has already admitted an append.
 */
export function admitNativeTermRecordLease(lease, chunk) {
    assertNativeTermRecordLease(lease, chunk);
    const state = /** @type {RecordLeaseState} */ (recordLeases.get(lease));
    if (state.admitted) { throw new Error('Native term-record input was already admitted'); }
    state.admitted = true;
}
