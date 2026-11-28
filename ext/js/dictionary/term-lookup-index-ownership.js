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

/** @typedef {import('./term-lookup-index-preparation.js').PreparedTermLookupIndex} PreparedIndex */
/** @type {WeakMap<object, {bytes: Uint8Array, buffer: ArrayBuffer, plan: object, owner: import('./term-bank-wasm-parser.js').TermBankColumnChunk, indexes: Map<string, PreparedIndex>}>} */
const ownedIndexes = new WeakMap()
/** @type {WeakSet<Uint8Array>} */
const ownedRecordFields = new WeakSet()
const arrayBufferResizableDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')

/**
 * @param {unknown} value
 * @returns {value is Uint8Array<ArrayBuffer>}
 */
function isCompletePrivateBuffer(value) {
    return value instanceof Uint8Array && value.buffer instanceof ArrayBuffer &&
    arrayBufferResizableDescriptor?.get?.call(value.buffer) !== true && value.byteOffset === 0 && value.byteLength > 0 &&
    value.byteLength === value.buffer.byteLength
}

/**
 * Called only at the parser-worker result boundary. Those payload buffers were
 * freshly produced and transferred by the worker. Shape alone never grants an
 * ownership witness. Keep all key/row aliases alive, including plans retained
 * by materialized record caches and plans needed by later record runs.
 * @param {import('./term-bank-wasm-parser.js').TermBankColumnChunk|null} chunk
 */
export function registerOwnedTermLookupIndexes(chunk) {
    const indexes = chunk?.preparedLookupIndexes
    if (!(indexes instanceof Map) || chunk === null) { return }
    // Native segmented payloads also back retained key-plan columns. Reject
    // entirely borrowed results before walking unrelated content/media rows.
    // Passing this screen still requires the complete ownership proof below.
    let hasIndependentPayload = false
    for (const prepared of indexes.values()) {
        if (typeof prepared !== 'object' || prepared === null) { return }
        const {bytes, preinternedPlan} = prepared
        if (!(bytes instanceof Uint8Array) || typeof preinternedPlan !== 'object' || preinternedPlan === null) { return }
        if (!isCompletePrivateBuffer(bytes)) { continue }
        const aliasesPlan = Object.values(preinternedPlan).some((value) => (
            ArrayBuffer.isView(value) ? value.buffer === bytes.buffer : value === bytes.buffer
        ))
        if (!aliasesPlan) {
            hasIndependentPayload = true
            break
        }
    }
    if (!hasIndependentPayload) { return }
    const protectedBuffers = getProtectedBuffers(chunk)
    if (protectedBuffers === null) { return }
    /** @type {Map<ArrayBufferLike, number>} */
    const references = new Map()
    for (const prepared of indexes.values()) {
        const buffer = prepared.bytes.buffer
        references.set(buffer, (references.get(buffer) ?? 0) + 1)
    }
    for (const prepared of indexes.values()) {
        const bytes = prepared.bytes
        if (!isCompletePrivateBuffer(bytes) || protectedBuffers.has(bytes.buffer) || references.get(bytes.buffer) !== 1) { continue }
        ownedIndexes.set(prepared, {bytes, buffer: bytes.buffer, plan: prepared.preinternedPlan, owner: chunk, indexes})
    }
}

/**
 * @param {import('./term-bank-wasm-parser.js').TermBankColumnChunk} chunk
 * @returns {Set<ArrayBufferLike>|null}
 */
function getProtectedBuffers(chunk) {
    if (!Array.isArray(chunk.expressionBytesList) || !Array.isArray(chunk.readingBytesList) ||
    chunk.expressionBytesList.length > 0 || chunk.readingBytesList.length > 0 ||
    !(chunk.preparedLookupIndexes instanceof Map) ||
    typeof chunk.termRecordPreinternedPlan !== 'object' || chunk.termRecordPreinternedPlan === null) { return null }
    /** @type {Set<ArrayBufferLike>} */
    const protectedBuffers = new Set()
    /** @param {object} value */
    const protectViews = (value) => {
        for (const member of Object.values(value)) {
            if (ArrayBuffer.isView(member)) {
                protectedBuffers.add(member.buffer)
            } else if (member instanceof ArrayBuffer || (typeof SharedArrayBuffer === 'function' && member instanceof SharedArrayBuffer)) {
                protectedBuffers.add(member)
            }
        }
    }
    protectViews(chunk)
    protectViews(chunk.termRecordPreinternedPlan)
    const references = /** @type {unknown} */ (Reflect.get(chunk, 'resolvedContentReferences'))
    const nestedValues = /** @type {unknown[]} */ ([chunk.contentDedupPlan, references])
    for (const nested of nestedValues) {
        if (typeof nested === 'object' && nested !== null) { protectViews(nested) }
    }
    if (!Array.isArray(chunk.mediaRows)) { return null }
    for (const media of chunk.mediaRows) {
        const row = media.row
        if (typeof row !== 'object' || row === null) { return null }
        for (const name of ['expressionBytes', 'readingBytes', 'glossaryJsonBytes', 'termEntryContentBytes']) {
            const bytes = /** @type {unknown} */ (Reflect.get(row, name))
            if (ArrayBuffer.isView(bytes)) { protectedBuffers.add(bytes.buffer) }
        }
    }
    for (const prepared of chunk.preparedLookupIndexes.values()) {
        if (typeof prepared !== 'object' || prepared === null ||
        !(prepared.bytes instanceof Uint8Array) || typeof prepared.preinternedPlan !== 'object' ||
        prepared.preinternedPlan === null) { return null }
        protectViews(prepared.preinternedPlan)
    }
    return protectedBuffers
}

/**
 * The store's field encoder creates these complete private buffers. Ordinary
 * callers and borrowed/shared views never receive this witness.
 * @param {Uint8Array} fields
 */
export function registerOwnedTermRecordFields(fields) {
    if (isCompletePrivateBuffer(fields)) { ownedRecordFields.add(fields) }
}

/**
 * @param {PreparedIndex|null} prepared
 * @param {Uint8Array} bytes
 * @param {Uint8Array|null} fields
 * @returns {boolean}
 */
export function canTakeOwnedTermLookupIndex(prepared, bytes, fields) {
    if (prepared === null || fields === null || typeof structuredClone !== 'function') { return false }
    const witness = ownedIndexes.get(prepared)
    if (typeof witness === 'undefined' || witness.owner.preparedLookupIndexes !== witness.indexes) { return false }
    const protectedBuffers = getProtectedBuffers(witness.owner)
    if (protectedBuffers === null || protectedBuffers.has(bytes.buffer)) { return false }
    for (const other of witness.indexes.values()) {
        if (other !== prepared && other.bytes.buffer === bytes.buffer) { return false }
    }
    const bytesProperty = Object.getOwnPropertyDescriptor(prepared, 'bytes')
    const planProperty = Object.getOwnPropertyDescriptor(prepared, 'preinternedPlan')
    return bytesProperty?.value === bytes && planProperty?.value === witness.plan &&
    witness.bytes === bytes && witness.buffer === bytes.buffer &&
    isCompletePrivateBuffer(bytes) && isCompletePrivateBuffer(fields) &&
    fields.buffer !== bytes.buffer && ownedRecordFields.has(fields)
}

/**
 * After synchronous validation, move both buffers into the store in one
 * transfer. Detached former views cannot mutate the queued snapshot. Revoking
 * the private witnesses prevents a second adoption or descriptor substitution.
 * @param {PreparedIndex} prepared
 * @param {Uint8Array} bytes
 * @param {Uint8Array} fields
 * @returns {{payload: Uint8Array<ArrayBuffer>, recordFields: Uint8Array<ArrayBuffer>}}
 * @throws {Error} If the private ownership witness is unavailable.
 */
export function takeOwnedTermLookupIndex(prepared, bytes, fields) {
    if (!canTakeOwnedTermLookupIndex(prepared, bytes, fields)) {
        throw new Error('Term lookup index ownership is unavailable')
    }
    const owned = structuredClone({payload: bytes, recordFields: fields}, {transfer: [bytes.buffer, fields.buffer]})
    ownedIndexes.delete(prepared)
    ownedRecordFields.delete(fields)
    return owned
}
