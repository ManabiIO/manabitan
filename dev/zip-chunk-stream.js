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
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */
/* eslint @stylistic/semi: ["error", "never"] */

/**
 * Bounded copies replace the pinned ZIP codec's recursive shrinking-tail
 * copies. Keep the original pending/flush rules, including its zero-copy
 * path when the entire input fits one chunk. Outputs split from a larger
 * input each own their buffer, as required by the worker transport.
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
        super({
            transform(chunk, controller) {
                if (pending !== null) {
                    const joined = new Uint8Array(pending.length + chunk.length)
                    joined.set(pending)
                    joined.set(chunk, pending.length)
                    chunk = joined
                }
                let offset = 0
                while (chunk.length - offset > chunkSize) {
                    controller.enqueue(chunk.slice(offset, offset + chunkSize))
                    offset += chunkSize
                }
                // Do not allocate a full-capacity buffer for small inputs.
                // The original splitter also borrows this last input until
                // more input arrives or flush transfers it to the consumer.
                pending = offset === 0 ? chunk : chunk.slice(offset)
            },
            flush(controller) {
                if (pending !== null && pending.length > 0) { controller.enqueue(pending) }
                pending = null
            },
        })
    }
}
