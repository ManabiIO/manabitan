/*
 * Copyright (C) 2023-2026  Yomitan Authors
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
 * Linear-time splitting for the pinned zip.js worker protocol. Every emitted
 * chunk owns its buffer, so transfer cannot detach another chunk or the input.
 * Retain one pending chunk, including a full chunk, until more input or flush;
 * this preserves the original splitter's chunk boundaries and delivery order.
 * @augments {TransformStream<Uint8Array, Uint8Array>}
 */
export class ChunkStream extends TransformStream {
    /** @param {number} chunkSize */
    constructor(chunkSize) {
        if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) {
            throw new RangeError('ZIP chunk size must be a positive safe integer')
        }
        /** @type {Uint8Array|null} */
        let pending = null
        let pendingLength = 0
        super({
            transform(chunk, controller) {
                let offset = 0
                if (pending !== null) {
                    const length = Math.min(chunkSize - pendingLength, chunk.length)
                    pending.set(chunk.subarray(0, length), pendingLength)
                    pendingLength += length
                    offset = length
                    if (pendingLength === chunkSize && offset < chunk.length) {
                        controller.enqueue(pending)
                        pending = null
                        pendingLength = 0
                    }
                }
                // Copy bounded outputs, never the successively shrinking tail.
                while (chunk.length - offset > chunkSize) {
                    controller.enqueue(new Uint8Array(chunk.subarray(offset, offset + chunkSize)))
                    offset += chunkSize
                }
                if (offset < chunk.length) {
                    pending ??= new Uint8Array(chunkSize)
                    pending.set(chunk.subarray(offset), pendingLength)
                    pendingLength += chunk.length - offset
                }
            },
            flush(controller) {
                if (pending !== null && pendingLength > 0) {
                    controller.enqueue(pendingLength === chunkSize ? pending : pending.slice(0, pendingLength))
                }
                pending = null
                pendingLength = 0
            },
        })
    }
}
