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


/** @typedef {import('./term-lookup-index-preparation.js').PreparedTermLookupIndex} PreparedIndex */
/** @typedef {import('./term-record-preinterned-plan.js').PreinternedTermRecordPlan} PreinternedPlan */
/** @type {WeakMap<object, {bytes: Uint8Array, preinternedPlan: PreinternedPlan}>} */
const preparedOrigins = new WeakMap();
const mapGet = Map.prototype.get;

/**
 * Construct a plain entry at the native worker-result boundary. This witness
 * proves entry identity and data properties, not ownership or validation of
 * its byte storage; append-time index validation is unchanged.
 * @param {Uint8Array} bytes
 * @param {PreinternedPlan} preinternedPlan
 * @param {Uint32Array|null} [routeFilter]
 * @returns {PreparedIndex}
 */
export function createPreparedTermLookupIndexForRecordFields(bytes, preinternedPlan, routeFilter) {
    const prepared = {bytes, preinternedPlan, ...(typeof routeFilter === 'undefined' ? {} : {routeFilter})};
    preparedOrigins.set(prepared, {bytes, preinternedPlan});
    return prepared;
}

/**
 * Select a current factory entry without invoking caller getters. Proxy maps
 * fail the builtin Map brand check; proxy entries miss the identity witness.
 * @param {unknown} indexes
 * @param {number} count
 * @returns {{prepared: PreparedIndex, bytes: Uint8Array, preinternedPlan: PreinternedPlan}|null}
 */
export function getSynchronousWholePreparedTermLookupIndex(indexes, count) {
    if (!Number.isSafeInteger(count) || count <= 0) { return null; }
    /** @type {unknown} */
    let prepared;
    try {
        prepared = mapGet.call(indexes, `0:${count}`);
    } catch {
        return null;
    }
    const map = /** @type {Map<unknown, unknown>} */ (indexes);
    if (
        Object.getPrototypeOf(map) !== Map.prototype ||
        Object.hasOwn(map, 'get') ||
        Object.getOwnPropertyDescriptor(Map.prototype, 'get')?.value !== mapGet ||
        typeof prepared !== 'object' || prepared === null
    ) { return null; }
    const origin = preparedOrigins.get(prepared);
    if (
        typeof origin === 'undefined' || Object.getPrototypeOf(prepared) !== Object.prototype ||
        !ArrayBuffer.isView(origin.bytes) || Object.getPrototypeOf(origin.bytes) !== Uint8Array.prototype ||
        typeof origin.preinternedPlan !== 'object' || origin.preinternedPlan === null ||
        Object.getOwnPropertyDescriptor(prepared, 'bytes')?.value !== origin.bytes ||
        Object.getOwnPropertyDescriptor(prepared, 'preinternedPlan')?.value !== origin.preinternedPlan
    ) { return null; }
    return {prepared: /** @type {PreparedIndex} */ (prepared), bytes: origin.bytes, preinternedPlan: origin.preinternedPlan};
}
