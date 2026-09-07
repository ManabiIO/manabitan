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

/**
 * Linear-time splitter for the pinned zip.js worker protocol. Output chunks own
 * their buffers: transferring one must not detach the input or other chunks.
 * Replaces the recursive tail-copy implementation in zip.js 2.7.54. The same
 * algorithmic issue is fixed upstream from 2.8.28; remove this backport when the
 * dependency upgrade and its worker/codec API changes have been validated.
 * @augments {TransformStream<Uint8Array, Uint8Array>}
 */
export class ChunkStream extends TransformStream {
    /**
     * @param {number} chunkSize
     */
    constructor(chunkSize) {
        const capacity = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : 64 * 1024;
        /** @type {Uint8Array|null} */
        let pending = null;
        let pendingLength = 0;
        super({
            transform(chunk, controller) {
                let offset = 0;
                if (pending !== null) {
                    const length = Math.min(capacity - pendingLength, chunk.length);
                    pending.set(chunk.subarray(0, length), pendingLength);
                    pendingLength += length;
                    offset = length;
                    if (pendingLength === capacity && offset < chunk.length) {
                        controller.enqueue(pending);
                        pending = null;
                        pendingLength = 0;
                    }
                }
                // Never copy the shrinking remainder of a large input. Each
                // emitted slice is bounded by capacity and copied exactly once.
                while (chunk.length - offset > capacity) {
                    controller.enqueue(new Uint8Array(chunk.subarray(offset, offset + capacity)));
                    offset += capacity;
                }
                if (offset < chunk.length) {
                    pending ??= new Uint8Array(capacity);
                    pending.set(chunk.subarray(offset), pendingLength);
                    pendingLength += chunk.length - offset;
                }
            },
            flush(controller) {
                if (pending !== null && pendingLength > 0) {
                    controller.enqueue(pendingLength === capacity ? pending : pending.slice(0, pendingLength));
                }
                pending = null;
                pendingLength = 0;
            },
        });
    }
}
