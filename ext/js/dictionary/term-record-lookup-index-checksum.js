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

export const LOOKUP_INDEX_CHUNK_HEADER_BYTES = 40

/**
 * Completes the integrity header of an already validated, privately owned
 * serialized chunk. Run before any part of that chunk reaches its sidecar.
 * @param {Uint8Array} chunk
 * @throws {Error} If the private chunk's serialized framing is inconsistent.
 */
export function completeTermRecordLookupChunkChecksums(chunk) {
    if (!(chunk instanceof Uint8Array) || chunk.byteLength < LOOKUP_INDEX_CHUNK_HEADER_BYTES) {
        throw new Error('Invalid term-record lookup checksum chunk')
    }
    const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength)
    const payloadEnd = LOOKUP_INDEX_CHUNK_HEADER_BYTES + view.getUint32(16, true)
    if (payloadEnd > chunk.byteLength) {
        throw new Error('Invalid term-record lookup checksum payload')
    }
    const {base, derived} = splitPersistedTermLookupIndex(chunk.subarray(LOOKUP_INDEX_CHUNK_HEADER_BYTES, payloadEnd))
    if (view.getUint32(20, true) !== base.byteLength) {
        throw new Error('Invalid term-record lookup checksum base')
    }
    view.setUint32(24, hashTermLookupKeyBytes(base), true)
    view.setUint32(28, hashTermLookupKeyBytes(derived), true)
    view.setUint32(32, hashTermLookupKeyBytes(chunk.subarray(payloadEnd)), true)
}
