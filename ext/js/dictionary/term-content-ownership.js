/*
 * Copyright (C) 2026  Yomitan Authors
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

export const TERM_CONTENT_RECENT_SOURCE_CACHE_MAX_BYTES = 48 * 1024 * 1024

export const TERM_CONTENT_RECENT_SOURCE_CACHE_MAX_AVERAGE_BYTES = 512

/** @type {WeakSet<ArrayBufferLike>} */
const ownedContentBuffers = new WeakSet()

/**
 * Complete small-definition groups are eligible for the existing recent-source
 * cache. Publish a compact owned slab so the parser can advance independently.
 * The ordinary cache still checks the actual published definitions afterwards.
 * @param {number|undefined} contentBytesLength
 * @param {unknown} uniqueCount
 * @param {unknown} sourceRowCount
 * @param {number} rowCount
 * @returns {boolean}
 */
export function shouldOwnTermContentBytes(contentBytesLength, uniqueCount, sourceRowCount, rowCount) {
    return (
        typeof contentBytesLength === 'number' && Number.isSafeInteger(contentBytesLength) &&
        contentBytesLength > 0 && contentBytesLength <= TERM_CONTENT_RECENT_SOURCE_CACHE_MAX_BYTES &&
        Number.isSafeInteger(rowCount) && rowCount > 0 &&
        typeof uniqueCount === 'number' && Number.isSafeInteger(uniqueCount) && uniqueCount > 0 &&
        uniqueCount <= rowCount && sourceRowCount === rowCount &&
        contentBytesLength <= uniqueCount * TERM_CONTENT_RECENT_SOURCE_CACHE_MAX_AVERAGE_BYTES
    )
}

/**
 * Called only for an explicit owned result from the parser worker. Its fresh
 * compact buffer is immutable after publication; ordinary caller arrays and
 * borrowed WASM memory never receive this ownership witness.
 * @param {Uint8Array|undefined} source
 * @returns {boolean}
 */
export function registerOwnedTermContent(source) {
    if (
        source instanceof Uint8Array &&
        source.byteOffset === 0 && source.byteLength > 0 && source.byteLength === source.buffer.byteLength
    ) {
        ownedContentBuffers.add(source.buffer)
        return true
    }
    return false
}

/**
 * Consumes a private one-time witness. The cache must first establish that its
 * retained range is the entire backing buffer, preserving cache byte coverage.
 * @param {Uint8Array} source
 * @returns {boolean}
 */
export function takeOwnedTermContent(source) {
    if (
        source.byteOffset !== 0 ||
        source.byteLength === 0 || source.byteLength !== source.buffer.byteLength
    ) { return false }
    return ownedContentBuffers.delete(source.buffer)
}
