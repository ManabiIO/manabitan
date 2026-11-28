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

/** @typedef {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan} Plan */
/** @typedef {import('./term-lookup-index-preparation.js').PreparedTermLookupIndex} Prepared */
/** @typedef {((this: unknown) => unknown)|undefined} Getter */
/** @typedef {{count: number, key: string, entry: Prepared, bytes: Uint8Array, plan: Plan, hasRouteFilter: boolean, routeFilter: Uint32Array|undefined}} Origin */
/** @typedef {'Uint8Array'|'Uint16Array'|'Uint32Array'} ViewKind */

/** @type {WeakMap<Plan, Plan>} */
const plans = new WeakMap()
/** @type {WeakMap<Map<string, Prepared>, Origin>} */
const indexes = new WeakMap()
const planKeys = /** @type {const} */ (['stringLengths', 'stringOffsets', 'stringHashes', 'stringsBuffer', 'expressionIndexes', 'readingIndexes'])
const mapPrototype = Map.prototype
/** @type {unknown} */
const typedPrototype = Object.getPrototypeOf(Uint8Array.prototype)
/* eslint-disable @typescript-eslint/unbound-method -- Captured intrinsics always receive an explicit receiver. */
const mapGet = Map.prototype.get
const mapHas = Map.prototype.has
/** @type {Getter} */
const mapSize = Object.getOwnPropertyDescriptor(mapPrototype, 'size')?.get
/** @type {Record<'buffer'|'byteOffset'|'byteLength'|'length'|'tag', Getter>} */
const typed = {
    buffer: Object.getOwnPropertyDescriptor(typedPrototype, 'buffer')?.get,
    byteOffset: Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset')?.get,
    byteLength: Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength')?.get,
    length: Object.getOwnPropertyDescriptor(typedPrototype, 'length')?.get,
    tag: Object.getOwnPropertyDescriptor(typedPrototype, Symbol.toStringTag)?.get,
}
/** @type {Getter} */
const bufferBytes = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
/** @type {Getter} */
const bufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
/* eslint-enable @typescript-eslint/unbound-method */
const prototypes = {Uint8Array: Uint8Array.prototype, Uint16Array: Uint16Array.prototype, Uint32Array: Uint32Array.prototype}
const widths = {Uint8Array: 1, Uint16Array: 2, Uint32Array: 4}

/**
 * These constructors own only new ordinary metadata. They do not brand an
 * input object or assert that any column values remain valid across an await.
 * Arguments are values already read by the producer, not a foreign record to
 * inspect here. The ordinary writable result preserves later stock behavior.
 * @param {Uint16Array} stringLengths
 * @param {Uint32Array|undefined} stringOffsets
 * @param {Uint32Array|undefined} stringHashes
 * @param {Uint8Array} stringsBuffer
 * @param {Uint16Array|Uint32Array} expressionIndexes
 * @param {Uint32Array} readingIndexes
 * @returns {Plan}
 */
export function createOwnedPreparedTermRecordPlan(stringLengths, stringOffsets, stringHashes, stringsBuffer, expressionIndexes, readingIndexes) {
    const plan = {stringLengths, stringOffsets, stringHashes, stringsBuffer, expressionIndexes, readingIndexes}
    plans.set(plan, {...plan})
    return plan
}

/**
 * An arbitrary map, entry or plan cannot acquire an ownership witness. This
 * creates the sole whole-range entry and map around a constructor-owned plan.
 * @param {number} count
 * @param {Uint8Array} bytes
 * @param {Plan} plan
 * @param {Uint32Array|undefined} [routeFilter]
 * @param {boolean} [hasRouteFilter]
 * @returns {Map<string, Prepared>|null}
 */
export function createOwnedWholePreparedLookupIndexes(count, bytes, plan, routeFilter = void 0, hasRouteFilter = false) {
    if (!plans.has(plan) || !Number.isSafeInteger(count) || count <= 0 || count > 65534) { return null }
    const key = `0:${count}`
    const entry = {bytes, preinternedPlan: plan, ...(hasRouteFilter ? {routeFilter} : {})}
    const result = new Map([[key, entry]])
    indexes.set(result, {count, key, entry, bytes, plan, hasRouteFilter, routeFilter})
    return result
}

/**
 * No property operation is performed on an unknown or proxy view: the
 * intrinsic view predicate rejects those before prototype/descriptor checks.
 * @param {unknown} value
 * @param {ViewKind} kind
 * @returns {number|null}
 */
function viewLength(value, kind) {
    if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== prototypes[kind]) { return null }
    if (Object.getPrototypeOf(prototypes[kind]) !== typedPrototype) { return null }
    for (const key of ['length', 'buffer', 'byteOffset', 'byteLength', Symbol.toStringTag]) {
        if (Object.hasOwn(value, key) || Object.hasOwn(prototypes[kind], key)) { return null }
        const getter = key === Symbol.toStringTag ? typed.tag : typed[/** @type {'length'|'buffer'|'byteOffset'|'byteLength'} */ (key)]
        if (Object.getOwnPropertyDescriptor(typedPrototype, key)?.get !== getter) { return null }
    }
    if (typed.tag?.call(value) !== kind) { return null }
    const buffer = typed.buffer?.call(value)
    const available = bufferBytes?.call(buffer)
    if (bufferResizable?.call(buffer) !== false || typeof available !== 'number') { return null }
    const length = typed.length?.call(value)
    const byteLength = typed.byteLength?.call(value)
    const byteOffset = typed.byteOffset?.call(value)
    if (
        typeof length !== 'number' || typeof byteLength !== 'number' || typeof byteOffset !== 'number' ||
        !Number.isSafeInteger(length) || !Number.isSafeInteger(byteLength) || !Number.isSafeInteger(byteOffset) ||
        length < 0 || byteOffset < 0 || byteLength !== length * widths[kind] || byteOffset + byteLength > available
    ) { return null }
    return length
}

/**
 * Called only after the existing completeness callbacks. This proves current
 * callback-free access, not cached validity of the mutable lookup contents.
 * Unknown maps decline before prototype checks or any user property access.
 * @param {Map<string, Prepared>|null} value
 * @param {number} count
 * @returns {Prepared|null}
 */
export function getOwnedWholePreparedLookupIndex(value, count) {
    const origin = value === null ? void 0 : indexes.get(value)
    if (typeof origin === 'undefined' || origin.count !== count || value === null) { return null }
    try {
        if (
            Object.getPrototypeOf(value) !== mapPrototype ||
            ['get', 'has', 'size'].some((key) => Object.hasOwn(value, key)) ||
            Object.getOwnPropertyDescriptor(mapPrototype, 'get')?.value !== mapGet ||
            Object.getOwnPropertyDescriptor(mapPrototype, 'has')?.value !== mapHas ||
            Object.getOwnPropertyDescriptor(mapPrototype, 'size')?.get !== mapSize ||
            mapSize?.call(value) !== 1 || mapGet.call(value, origin.key) !== origin.entry
        ) { return null }
        const {entry, plan} = origin
        const snapshot = plans.get(plan)
        if (typeof snapshot === 'undefined' || Object.getPrototypeOf(entry) !== Object.prototype || Object.getPrototypeOf(plan) !== Object.prototype) { return null }
        for (const [key, expected] of [['bytes', origin.bytes], ['preinternedPlan', plan]]) {
            const descriptor = Object.getOwnPropertyDescriptor(entry, /** @type {string} */ (key))
            if (typeof descriptor === 'undefined' || !('value' in descriptor) || descriptor.value !== expected) { return null }
        }
        for (const key of planKeys) {
            const descriptor = Object.getOwnPropertyDescriptor(plan, key)
            if (typeof descriptor === 'undefined' || !('value' in descriptor) || descriptor.value !== snapshot[key]) { return null }
        }
        const route = Object.getOwnPropertyDescriptor(entry, 'routeFilter')
        if (origin.hasRouteFilter ?
            typeof route === 'undefined' || !('value' in route) || route.value !== origin.routeFilter :
            typeof route !== 'undefined' || 'routeFilter' in entry
        ) { return null }
        const byteLength = viewLength(origin.bytes, 'Uint8Array')
        const stringCount = viewLength(snapshot.stringLengths, 'Uint16Array')
        const stringBytes = viewLength(snapshot.stringsBuffer, 'Uint8Array')
        const expressions = viewLength(snapshot.expressionIndexes, 'Uint32Array') ?? viewLength(snapshot.expressionIndexes, 'Uint16Array')
        const readings = viewLength(snapshot.readingIndexes, 'Uint32Array')
        if (
            byteLength === null || byteLength === 0 || stringCount === null || stringCount === 0 || stringCount > 65534 ||
            stringBytes === null || stringBytes === 0 || expressions === null || expressions < count || readings === null || readings < count ||
            (typeof snapshot.stringOffsets !== 'undefined' && viewLength(snapshot.stringOffsets, 'Uint32Array') !== stringCount) ||
            (typeof snapshot.stringHashes !== 'undefined' && viewLength(snapshot.stringHashes, 'Uint32Array') !== stringCount) ||
            (typeof origin.routeFilter !== 'undefined' && viewLength(origin.routeFilter, 'Uint32Array') === null)
        ) { return null }
        return entry
    } catch {
        return null
    }
}
