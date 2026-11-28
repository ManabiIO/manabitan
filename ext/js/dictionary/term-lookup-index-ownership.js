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
/** @typedef {{name: string, value: unknown}} DataBinding */
/** @typedef {{key: string, prepared: PreparedIndex, bytes: Uint8Array, buffer: ArrayBuffer, plan: object, bindings: DataBinding[]}} IndexWitness */
/** @typedef {{entry: object, bindings: DataBinding[], row: object, rowBindings: DataBinding[], paths: unknown[], pathValues: unknown[]}} ProjectedMediaWitness */
/** @typedef {{owner: import('./term-bank-wasm-parser.js').TermBankColumnChunk, indexes: Map<string, PreparedIndex>, bindings: DataBinding[], plan: object, planBindings: DataBinding[], contentPlan: object|null, mediaRows: unknown[], media: ProjectedMediaWitness[], emptyLists: unknown[][], nestedObjects: Map<string, unknown>, entries: IndexWitness[]}} OwnerWitness */
/** @type {WeakMap<object, {entry: IndexWitness, owner: OwnerWitness}>} */
const ownedIndexes = new WeakMap()
/** @type {WeakSet<object>} */
const receiverOwnedIndexMaps = new WeakSet()
/** @type {WeakMap<object, object>} */
const consumerOrigins = new WeakMap()
/** @type {WeakSet<Uint8Array>} */
const ownedRecordFields = new WeakSet()
const invalidDataProperty = Symbol('Invalid ownership data property')
const arrayBufferByteLengthDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')
const arrayBufferResizableDescriptor = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')
const sharedArrayBufferByteLengthDescriptor = typeof SharedArrayBuffer === 'function' ?
    Object.getOwnPropertyDescriptor(SharedArrayBuffer.prototype, 'byteLength') :
    void 0
const rowBindingNames = [
    'rowCount',
    'expressionBytesList',
    'readingBytesList',
    'contentBytesList',
    'readingEqualsExpressionList',
    'scoreList',
    'sequenceList',
    'termRecordPreinternedPlan',
    'preparedLookupIndexes',
    'contentDedupPlan',
    'contentUniqueIndexList',
    'contentBytesBuffer',
]
const viewShadowNames = ['buffer', 'byteOffset', 'byteLength', 'length', 'constructor', 'subarray', 'slice', 'set', Symbol.iterator]
const bufferShadowNames = ['byteLength', 'resizable', 'maxByteLength', 'constructor', 'transfer', 'transferToFixedLength']
/** @type {Set<object>} */
const viewPrototypes = new Set([Uint8Array.prototype, Uint16Array.prototype, Uint32Array.prototype, Int32Array.prototype, Float64Array.prototype])

/**
 * ArrayBuffer.isView rejects Proxy wrappers without invoking their traps. Check
 * per-object shadows before reading geometry; global intrinsic replacement is
 * outside the parser/store ownership contract.
 * @param {unknown} value
 * @param {boolean} [allowShared=false]
 * @returns {ArrayBufferLike|null}
 */
function getPlainViewBuffer(value, allowShared = false) {
    if (!ArrayBuffer.isView(value)) { return null }
    const prototype = /** @type {unknown} */ (Object.getPrototypeOf(value))
    if (typeof prototype !== 'object' || prototype === null || !viewPrototypes.has(prototype)) { return null }
    for (const name of viewShadowNames) {
        if (Object.hasOwn(value, name)) { return null }
    }
    const buffer = value.buffer
    const shared = allowShared && typeof SharedArrayBuffer === 'function' && Object.getPrototypeOf(buffer) === SharedArrayBuffer.prototype
    if (!shared && Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype) { return null }
    for (const name of bufferShadowNames) {
        if (Object.hasOwn(buffer, name)) { return null }
    }
    // Preserve intrinsic identity; Reflect.apply below supplies each backing buffer as this.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const byteLengthGetter = shared ? sharedArrayBufferByteLengthDescriptor?.get : arrayBufferByteLengthDescriptor?.get
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const resizableGetter = arrayBufferResizableDescriptor?.get
    if (typeof byteLengthGetter !== 'function') { return null }
    try {
        if (
            Reflect.apply(byteLengthGetter, buffer, []) !== buffer.byteLength ||
            (
                !shared && typeof resizableGetter === 'function' &&
                Reflect.apply(resizableGetter, buffer, []) === true
            )
        ) { return null }
    } catch {
        // A forged prototype does not establish either internal backing-buffer
        // brand. Preserve the ordinary eager path on that input.
        return null
    }
    return buffer
}

/**
 * @param {unknown} value
 * @returns {value is Uint8Array<ArrayBuffer>}
 */
function isCompletePrivateBuffer(value) {
    const buffer = getPlainViewBuffer(value)
    return buffer !== null && value instanceof Uint8Array &&
    Object.getPrototypeOf(value) === Uint8Array.prototype &&
    value.byteOffset === 0 && value.byteLength > 0 && value.byteLength === buffer.byteLength
}

/**
 * Only call on an object already proven to be a worker/factory object. A late
 * accessor declines the optimization without adding observable getter reads.
 * @param {object} value
 * @param {string} name
 * @returns {unknown}
 */
function getDataValue(value, name) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    if (typeof descriptor === 'undefined') { return void 0 }
    return 'value' in descriptor ? /** @type {unknown} */ (descriptor.value) : invalidDataProperty
}

/**
 * @param {object} value
 * @param {string[]} [names=Object.keys(value)]
 * @returns {DataBinding[]|null}
 */
function getDataBindings(value, names = Object.keys(value)) {
    if (Object.getPrototypeOf(value) !== Object.prototype) { return null }
    /** @type {DataBinding[]} */
    const bindings = []
    for (const name of names) {
        const member = getDataValue(value, name)
        if (member === invalidDataProperty) { return null }
        bindings.push({name, value: member})
    }
    return bindings
}

/**
 * @param {object} value
 * @param {DataBinding[]} bindings
 * @returns {boolean}
 */
function matchesBindings(value, bindings) {
    return Object.getPrototypeOf(value) === Object.prototype &&
    bindings.every(({name, value: member}) => getDataValue(value, name) === member)
}

/**
 * These are known plain producer objects, never replacement objects from a
 * mutable graph. Read descriptors rather than invoking newly added accessors.
 * Content/key plans contain only scalar metadata and direct typed columns;
 * other nested shapes keep the eager snapshot path.
 * @param {object} value
 * @param {ArrayBuffer} payloadBuffer
 * @param {boolean} [onlyColumns=false]
 * @param {ArrayBuffer|null} [fieldsBuffer=null]
 * @param {Map<string, unknown>|null} [nestedObjects=null]
 * @param {object|null} [references=null]
 * @returns {boolean}
 */
function hasDisjointDataViews(value, payloadBuffer, onlyColumns = false, fieldsBuffer = null, nestedObjects = null, references = null) {
    if (Object.getPrototypeOf(value) !== Object.prototype) { return false }
    const descriptors = Object.getOwnPropertyDescriptors(value)
    for (const name of Reflect.ownKeys(descriptors)) {
        // Worker/factory shapes have string bindings only. Unknown symbols and
        // nested values decline without walking a caller-supplied graph.
        if (typeof name !== 'string') { return false }
        const descriptor = descriptors[name]
        if (!('value' in descriptor)) { return false }
        const member = /** @type {unknown} */ (descriptor.value)
        if (member === payloadBuffer || (fieldsBuffer !== null && member === fieldsBuffer)) { return false }
        if (ArrayBuffer.isView(member)) {
            // The worker's shared content slab is retained, never transferred.
            // Genuine shared backing cannot alias either private output buffer.
            const buffer = getPlainViewBuffer(member, !onlyColumns && name === 'contentBytesBuffer')
            if (buffer === null || buffer === payloadBuffer || buffer === fieldsBuffer) { return false }
        } else if (
            typeof member === 'object' && member !== null &&
            (onlyColumns || (nestedObjects?.get(name) !== member && !(name === 'resolvedContentReferences' && references === member)))
        ) {
            return false
        }
    }
    return true
}

/**
 * @param {Map<string, PreparedIndex>} indexes
 * @returns {boolean}
 */
function isPlainIndexMap(indexes) {
    return Object.getPrototypeOf(indexes) === Map.prototype && Reflect.ownKeys(indexes).length === 0
}

/**
 * @param {object} prepared
 * @returns {boolean}
 */
function hasPreparedIndexShape(prepared) {
    return Reflect.ownKeys(prepared).every((name) => name === 'bytes' || name === 'preinternedPlan' || name === 'routeFilter')
}

/**
 * @param {unknown[]} value
 * @returns {boolean}
 */
function isEmptyPlainArray(value) {
    return Object.getPrototypeOf(value) === Array.prototype && getDataValue(value, 'length') === 0 && Reflect.ownKeys(value).length === 1
}

/**
 * Only dense, unmodified array data is part of a producer witness. Descriptors
 * avoid invoking late getters or a replaced iterator while checking identities.
 * @param {unknown} value
 * @returns {unknown[]|null}
 */
function snapshotPlainArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) { return null }
    const length = getDataValue(value, 'length')
    if (typeof length !== 'number' || Reflect.ownKeys(value).length !== length + 1) { return null }
    const values = []
    for (let i = 0; i < length; ++i) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i))
        if (typeof descriptor === 'undefined' || !('value' in descriptor)) { return null }
        values.push(/** @type {unknown} */ (descriptor.value))
    }
    return values
}

/**
 * @param {unknown[]} value
 * @param {unknown[]} expected
 * @returns {boolean}
 */
function matchesPlainArray(value, expected) {
    if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        getDataValue(value, 'length') !== expected.length ||
        Reflect.ownKeys(value).length !== expected.length + 1
    ) { return false }
    for (let i = 0; i < expected.length; ++i) {
        if (getDataValue(value, String(i)) !== expected[i]) { return false }
    }
    return true
}

/**
 * Projected worker rows contain only scalar metadata and direct key views.
 * Ordinary decoded media and arbitrary nested objects retain eager snapshots.
 * @param {unknown[]} mediaRows
 * @returns {ProjectedMediaWitness[]|null}
 */
function snapshotProjectedMedia(mediaRows) {
    const entries = snapshotPlainArray(mediaRows)
    if (entries === null) { return null }
    /** @type {ProjectedMediaWitness[]} */
    const media = []
    for (const entry of entries) {
        if (typeof entry !== 'object' || entry === null) { return null }
        const bindings = getDataBindings(entry)
        const row = getDataValue(entry, 'row')
        const paths = getDataValue(entry, 'imagePaths')
        const index = getDataValue(entry, 'index')
        if (
            bindings === null || bindings.length !== 3 || Reflect.ownKeys(entry).length !== 3 ||
            typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 ||
            typeof row !== 'object' || row === null || !Array.isArray(paths)
        ) { return null }
        const rowBindings = getDataBindings(row)
        const pathValues = snapshotPlainArray(paths)
        const content = getDataValue(row, 'termEntryContentBytes')
        if (
            rowBindings === null || Reflect.ownKeys(row).length !== rowBindings.length ||
            pathValues === null || pathValues.length === 0 || pathValues.some((path) => typeof path !== 'string') ||
            getDataValue(row, 'glossaryJsonBytes') !== void 0 ||
            !(content instanceof Uint8Array) || getPlainViewBuffer(content) === null || content.byteLength !== 0
        ) { return null }
        media.push({entry, bindings, row, rowBindings, paths, pathValues})
    }
    return media
}

/**
 * Compare captured identities before inspecting the original plain objects.
 * No replacement media graph, getter or iterator participates in the check.
 * @param {OwnerWitness} witness
 * @param {ArrayBuffer} payloadBuffer
 * @param {ArrayBuffer|null} fieldsBuffer
 * @returns {boolean}
 */
function hasUnchangedProjectedMedia(witness, payloadBuffer, fieldsBuffer) {
    const {mediaRows, media} = witness
    if (
        Object.getPrototypeOf(mediaRows) !== Array.prototype ||
        getDataValue(mediaRows, 'length') !== media.length || Reflect.ownKeys(mediaRows).length !== media.length + 1
    ) { return false }
    for (let i = 0; i < media.length; ++i) {
        const {entry, bindings, row, rowBindings, paths, pathValues} = media[i]
        if (
            getDataValue(mediaRows, String(i)) !== entry ||
            !matchesBindings(entry, bindings) || Reflect.ownKeys(entry).length !== bindings.length ||
            !matchesBindings(row, rowBindings) || Reflect.ownKeys(row).length !== rowBindings.length ||
            !matchesPlainArray(paths, pathValues) ||
            !hasDisjointDataViews(row, payloadBuffer, true, fieldsBuffer)
        ) { return false }
    }
    return true
}

/**
 * @param {OwnerWitness} witness
 * @param {ArrayBuffer} payloadBuffer
 * @param {ArrayBuffer|null} [fieldsBuffer=null]
 * @returns {boolean}
 */
function hasUnchangedOwner(witness, payloadBuffer, fieldsBuffer = null) {
    const {owner, indexes, bindings, plan, planBindings, contentPlan, mediaRows, emptyLists, nestedObjects, entries} = witness
    if (
        !matchesBindings(owner, bindings) || !isPlainIndexMap(indexes) || indexes.size !== entries.length ||
        getDataValue(owner, 'mediaRows') !== mediaRows ||
        !hasUnchangedProjectedMedia(witness, payloadBuffer, fieldsBuffer) ||
        emptyLists.some((list) => !isEmptyPlainArray(list)) ||
        !hasDisjointDataViews(owner, payloadBuffer, false, fieldsBuffer, nestedObjects) ||
        !matchesBindings(plan, planBindings) || !hasDisjointDataViews(plan, payloadBuffer, true, fieldsBuffer) ||
        (contentPlan !== null && !hasDisjointDataViews(contentPlan, payloadBuffer, true, fieldsBuffer))
    ) { return false }
    for (const entry of entries) {
        if (
            indexes.get(entry.key) !== entry.prepared ||
            Object.getPrototypeOf(entry.prepared) !== Object.prototype || !hasPreparedIndexShape(entry.prepared) ||
            getDataValue(entry.prepared, 'bytes') !== entry.bytes ||
            getDataValue(entry.prepared, 'preinternedPlan') !== entry.plan ||
            !matchesBindings(entry.plan, entry.bindings) ||
            !hasDisjointDataViews(entry.plan, payloadBuffer, true, fieldsBuffer)
        ) { return false }
        const routeFilter = getDataValue(entry.prepared, 'routeFilter')
        if (routeFilter !== null && typeof routeFilter !== 'undefined') {
            const buffer = getPlainViewBuffer(routeFilter)
            if (buffer === null || buffer === payloadBuffer || buffer === fieldsBuffer) { return false }
        }
    }
    return true
}

/**
 * Called only at the parser-worker result boundary, before consumers can retain
 * or replace columns. Only no-media groups or native-projected media with
 * captured plain data bindings are eligible. Other media, nested content shapes
 * and borrowed native segments retain their existing eager snapshot behavior.
 * @param {import('./term-bank-wasm-parser.js').TermBankColumnChunk|null} chunk
 */
export function registerOwnedTermLookupIndexes(chunk) {
    const indexes = chunk?.preparedLookupIndexes
    if (chunk === null || !(indexes instanceof Map) || !isPlainIndexMap(indexes)) { return }
    const bindings = getDataBindings(chunk, rowBindingNames)
    const plan = getDataValue(chunk, 'termRecordPreinternedPlan')
    const contentPlan = getDataValue(chunk, 'contentDedupPlan')
    const mediaRows = getDataValue(chunk, 'mediaRows')
    const emptyLists = ['expressionBytesList', 'readingBytesList', 'contentBytesList'].map((name) => getDataValue(chunk, name))
    if (
        bindings === null || typeof plan !== 'object' || plan === null ||
        (contentPlan !== null && typeof contentPlan !== 'object') ||
        !Array.isArray(mediaRows) ||
        emptyLists.some((list) => !Array.isArray(list) || list.length > 0)
    ) { return }
    const planBindings = getDataBindings(plan)
    const media = snapshotProjectedMedia(mediaRows)
    if (planBindings === null || media === null) { return }
    /** @type {OwnerWitness} */
    const owner = {
        owner: chunk,
        indexes,
        bindings,
        plan,
        planBindings,
        contentPlan,
        mediaRows,
        media,
        emptyLists: /** @type {unknown[][]} */ (emptyLists),
        nestedObjects: new Map([
            ['expressionBytesList', emptyLists[0]],
            ['readingBytesList', emptyLists[1]],
            ['contentBytesList', emptyLists[2]],
            ['termRecordPreinternedPlan', plan],
            ['contentDedupPlan', contentPlan],
            ['preparedLookupIndexes', indexes],
            ['mediaRows', mediaRows],
        ]),
        entries: [],
    }
    for (const [key, prepared] of indexes) {
        if (typeof prepared !== 'object' || prepared === null || Object.getPrototypeOf(prepared) !== Object.prototype || !hasPreparedIndexShape(prepared)) { return }
        const bytes = getDataValue(prepared, 'bytes')
        const entryPlan = getDataValue(prepared, 'preinternedPlan')
        if (!isCompletePrivateBuffer(bytes) || typeof entryPlan !== 'object' || entryPlan === null) { continue }
        const entryBindings = getDataBindings(entryPlan)
        if (entryBindings === null) { return }
        owner.entries.push({key, prepared, bytes, buffer: bytes.buffer, plan: entryPlan, bindings: entryBindings})
    }
    if (owner.entries.length !== indexes.size) { return }
    for (const entry of owner.entries) {
        if (
            owner.entries.some((other) => other !== entry && other.buffer === entry.buffer) ||
            !hasUnchangedOwner(owner, entry.buffer)
        ) { continue }
        ownedIndexes.set(entry.prepared, {entry, owner})
        receiverOwnedIndexMaps.add(indexes)
    }
}

/**
 * Called only for the fresh objects created by the store's resolved-reference
 * factory. A spread copy or Proxy around that result does not inherit origin.
 * @param {object} chunk
 * @param {object} references
 */
export function registerTermLookupIndexConsumer(chunk, references) {
    const indexes = getDataValue(chunk, 'preparedLookupIndexes')
    // Factory callers can supply arbitrary graphs. Receiver identity is enough
    // to skip bookkeeping without reading a replacement Map or invoking traps.
    if (typeof indexes === 'object' && indexes !== null && receiverOwnedIndexMaps.has(indexes)) {
        consumerOrigins.set(chunk, references)
    }
}

/**
 * Only the persisted-only append route can supply this consumer. Requiring its
 * ordinary empty projection columns also excludes caller-owned offset/length
 * views that could otherwise alias a payload outside the consumer object.
 * @param {object} chunk
 * @param {unknown} contentOffsets
 * @param {unknown} contentLengths
 * @returns {object|null}
 */
export function getTermLookupIndexConsumer(chunk, contentOffsets, contentLengths) {
    if (
        !consumerOrigins.has(chunk) ||
        getPlainViewBuffer(contentOffsets) === null || getPlainViewBuffer(contentLengths) === null ||
        !(contentOffsets instanceof Float64Array) || !(contentLengths instanceof Uint32Array) ||
        contentOffsets.length > 0 || contentLengths.length > 0
    ) { return null }
    return chunk
}

/**
 * The caller has captured and invoked the original allocation-owning encoder.
 * An overridable encoder's return value never grants ownership by itself.
 * @param {Uint8Array} fields
 */
export function registerOwnedTermRecordFields(fields) {
    if (isCompletePrivateBuffer(fields)) { ownedRecordFields.add(fields) }
}

/**
 * @param {PreparedIndex|null} prepared
 * @param {Uint8Array} bytes
 * @param {Uint8Array|null} fields
 * @param {object|null} consumer
 * @returns {boolean}
 */
export function canTakeOwnedTermLookupIndex(prepared, bytes, fields, consumer) {
    if (prepared === null || fields === null || consumer === null || typeof structuredClone !== 'function') { return false }
    const witness = ownedIndexes.get(prepared)
    const references = consumerOrigins.get(consumer)
    if (
        typeof witness === 'undefined' || typeof references === 'undefined' ||
        witness.entry.bytes !== bytes || !ownedRecordFields.has(fields) ||
        !isCompletePrivateBuffer(bytes) || !isCompletePrivateBuffer(fields) ||
        witness.entry.buffer !== bytes.buffer || fields.buffer === bytes.buffer
    ) { return false }
    const {owner} = witness
    if (
        !hasUnchangedOwner(owner, bytes.buffer, fields.buffer) ||
        !matchesBindings(consumer, owner.bindings) ||
        getDataValue(consumer, 'resolvedContentReferences') !== references ||
        !hasDisjointDataViews(consumer, bytes.buffer, false, fields.buffer, owner.nestedObjects, references) ||
        !hasDisjointDataViews(references, bytes.buffer, true, fields.buffer)
    ) { return false }
    const mediaRows = getDataValue(consumer, 'mediaRows')
    if (typeof mediaRows !== 'undefined' && mediaRows !== owner.mediaRows) { return false }
    for (const name of ['uniqueIndexList', 'offsets', 'lengths']) {
        const buffer = getPlainViewBuffer(getDataValue(references, name))
        if (buffer === null || buffer === bytes.buffer || buffer === fields.buffer) { return false }
    }
    return true
}

/**
 * Authoritative validation precedes this atomic move. Detached
 * former views cannot mutate queued bytes; revocation prevents a second move.
 * @param {PreparedIndex} prepared
 * @param {Uint8Array} bytes
 * @param {Uint8Array} fields
 * @param {object|null} consumer
 * @returns {{payload: Uint8Array<ArrayBuffer>, recordFields: Uint8Array<ArrayBuffer>}}
 * @throws {Error} If the private ownership witness is unavailable.
 */
export function takeOwnedTermLookupIndex(prepared, bytes, fields, consumer) {
    if (!canTakeOwnedTermLookupIndex(prepared, bytes, fields, consumer)) {
        throw new Error('Term lookup index ownership is unavailable')
    }
    const owned = structuredClone({payload: bytes, recordFields: fields}, {transfer: [bytes.buffer, fields.buffer]})
    ownedIndexes.delete(prepared)
    ownedRecordFields.delete(fields)
    return owned
}
