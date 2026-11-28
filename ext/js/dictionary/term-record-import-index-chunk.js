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

import {hashTermLookupKeyBytes, splitPersistedTermLookupIndex} from './term-lookup-index.js'

/** @typedef {{header: Uint8Array, payload: Uint8Array, recordFields: Uint8Array, byteLength: number}} DeferredImportIndexChunk */
/** @typedef {Uint8Array|DeferredImportIndexChunk} ImportIndexChunk */

/**
 * Preserve each logical chunk's exact on-disk byte sequence without allocating
 * its concatenated envelope. The owner already validated and snapshotted the
 * authoritative fields. Hash the same immutable bytes that the writer uses.
 * @param {ImportIndexChunk[]} chunks
 * @returns {Uint8Array[]}
 * @throws {Error} If the private chunk framing is inconsistent.
 */
export function prepareImportIndexChunkParts(chunks) {
    /** @type {Uint8Array[]} */
    const parts = []
    for (const chunk of chunks) {
        if (chunk instanceof Uint8Array) {
            parts.push(chunk)
            continue
        }
        const {header, payload, recordFields, byteLength} = chunk
        if (
            !(header instanceof Uint8Array) || header.byteLength !== 40 ||
            !(payload instanceof Uint8Array) || !(recordFields instanceof Uint8Array) ||
            byteLength !== header.byteLength + payload.byteLength + recordFields.byteLength
        ) { throw new TypeError('Invalid import index chunk parts') }
        const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
        const {base, derived} = splitPersistedTermLookupIndex(payload)
        if (view.getUint32(16, true) !== payload.byteLength || view.getUint32(20, true) !== base.byteLength) {
            throw new Error('Invalid import index chunk lengths')
        }
        view.setUint32(24, hashTermLookupKeyBytes(base), true)
        view.setUint32(28, hashTermLookupKeyBytes(derived), true)
        view.setUint32(32, hashTermLookupKeyBytes(recordFields), true)
        parts.push(header, payload, recordFields)
    }
    return parts
}
