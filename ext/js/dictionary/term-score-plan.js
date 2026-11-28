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

/** @typedef {{values: Int32Array, keys: Uint16Array}} TermScorePlan */
/** @typedef {{scoreList: number[]|Int32Array|Float64Array|null, scorePlan?: TermScorePlan}} TermScoreSource */

const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')
const arrayBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')

/**
 * Capture only data descriptors and ordinary private views. This proves that
 * reading the captured columns cannot run caller code during one synchronous
 * encoder invocation; it does not cache any score-value validation.
 * @param {TermScoreSource} source
 * @param {number} [count]
 * @returns {TermScorePlan|null}
 */
export function getSynchronousTermScorePlan(source, count) {
    const scores = Object.getOwnPropertyDescriptor(source, 'scoreList')
    const descriptor = Object.getOwnPropertyDescriptor(source, 'scorePlan')
    if (!scores || !Object.hasOwn(scores, 'value') || scores.value !== null ||
    !descriptor || !Object.hasOwn(descriptor, 'value') ||
    (typeof count !== 'undefined' && (!Number.isSafeInteger(count) || count < 0))) { return null }
    const plan = /** @type {unknown} */ (descriptor.value)
    if (typeof plan !== 'object' || plan === null || Object.getPrototypeOf(plan) !== Object.prototype) { return null }
    const values = /** @type {unknown} */ (Object.getOwnPropertyDescriptor(plan, 'values')?.value)
    const keys = /** @type {unknown} */ (Object.getOwnPropertyDescriptor(plan, 'keys')?.value)
    if (!(values instanceof Int32Array) || !(keys instanceof Uint16Array) ||
    !ArrayBuffer.isView(values) || !ArrayBuffer.isView(keys) ||
    Object.getPrototypeOf(values) !== Int32Array.prototype ||
    Object.getPrototypeOf(keys) !== Uint16Array.prototype) { return null }
    for (const column of [values, keys]) {
        if (Object.hasOwn(column, 'buffer') || Object.hasOwn(column, 'length') ||
        Object.hasOwn(column, 'byteOffset') || Object.hasOwn(column, 'byteLength')) { return null }
    }
    const buffer = /** @type {ArrayBufferLike} */ (values.buffer)
    if (keys.buffer !== buffer || Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
    typeof arrayBufferByteLength?.get !== 'function') { return null }
    try {
        const bytes = Number(arrayBufferByteLength.get.call(buffer))
        if ((typeof arrayBufferResizable?.get === 'function' && arrayBufferResizable.get.call(buffer) === true) ||
        values.byteOffset !== 0 || values.length >= 0xffff || (typeof count !== 'undefined' && keys.length !== count) ||
        keys.byteOffset < values.byteLength || keys.byteOffset + keys.byteLength > bytes ||
        (keys.length > 0 && values.length === 0)) { return null }
        // A detached buffer and an ordinary empty buffer both report zero.
        // Constructing an empty view distinguishes them without reading data.
        if (bytes === 0 && new Uint8Array(buffer).byteLength !== 0) { return null }
    } catch { return null }
    return {values, keys}
}

/**
 * Validate the live dictionary and row keys before copying prepared columns.
 * Noncanonical but value-valid plans use the ordinary first-use encoder.
 * @param {TermScorePlan} plan
 * @returns {boolean}
 */
export function isCanonicalTermScorePlan({values, keys}) {
    if (values.length >= 0xffff) { return false }
    const seen = new Set()
    for (let i = 0; i < values.length; ++i) {
        const value = values[i]
        if (seen.has(value)) { return false }
        seen.add(value)
    }
    let next = 0
    for (let i = 0; i < keys.length; ++i) {
        const key = keys[i]
        if (key > next || key >= values.length) { return false }
        if (key === next) { ++next }
    }
    return next === values.length
}

/**
 * Preserve raw scalar access while keeping fallback compact reads bounded.
 * @param {TermScoreSource} source
 * @param {number} index
 * @returns {number}
 * @throws {TypeError} If a compact score source is malformed.
 * @throws {RangeError} If its requested row or score key is out of bounds.
 */
export function readTermScore(source, index) {
    const {scoreList} = source
    if (scoreList !== null) { return scoreList[index] ?? 0 }
    const plan = getSynchronousTermScorePlan(source)
    if (plan === null) { throw new TypeError('Compact term score columns are invalid') }
    if (!Number.isSafeInteger(index) || index < 0 || index >= plan.keys.length) {
        throw new RangeError('Compact term score row is out of bounds')
    }
    const key = plan.keys[index]
    if (key >= plan.values.length) { throw new RangeError('Compact term score key is out of bounds') }
    return plan.values[key]
}

/**
 * A subrange shares storage but must establish its own first-use score order.
 * @param {TermScoreSource} source
 * @param {number} start
 * @param {number} end
 * @returns {TermScoreSource}
 * @throws {TypeError} If a compact score source is malformed.
 * @throws {RangeError} If its requested range is out of bounds.
 */
export function sliceTermScoreSource(source, start, end) {
    const {scoreList} = source
    if (scoreList !== null) { return {scoreList: scoreList.slice(start, end)} }
    const plan = getSynchronousTermScorePlan(source)
    if (plan === null) { throw new TypeError('Compact term score columns are invalid') }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
    start < 0 || end < start || end > plan.keys.length) {
        throw new RangeError('Compact term score range is out of bounds')
    }
    const keys = new Uint16Array(plan.keys.buffer, plan.keys.byteOffset + start * Uint16Array.BYTES_PER_ELEMENT, end - start)
    return {scoreList: null, scorePlan: {values: plan.values, keys}}
}

/**
 * Copy retired native scratch into one outbound buffer instead of an owned
 * raw Int32 score column. The original native scores remain untouched.
 * @param {Int32Array} values
 * @param {Uint16Array} keys
 * @returns {TermScorePlan|null}
 */
export function copyOwnedTermScorePlan(values, keys) {
    const count = keys.length
    const uniqueCount = values.length
    const bytes = values.byteLength + keys.byteLength
    if (count <= 0 || uniqueCount <= 0 || uniqueCount >= 0xffff || bytes > count * 4) { return null }
    const buffer = new ArrayBuffer(bytes)
    const ownedValues = new Int32Array(buffer, 0, uniqueCount)
    const ownedKeys = new Uint16Array(buffer, ownedValues.byteLength, count)
    ownedValues.set(values)
    ownedKeys.set(keys)
    return {values: ownedValues, keys: ownedKeys}
}
