/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2016-2022  Yomichan Authors
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

const WASM_PAGE_BYTES = 65536;
// Fixed scratch reservation shared by the JS control and native experiment.
// Each replacement memory remains fixed; retained views never detach.
const TABLE_START = 128 * WASM_PAGE_BYTES;

/**
 * A database owns one authoritative set of hot metadata columns. Capacity
 * changes allocate a replacement memory; existing views are never detached.
 * Publish a replacement only after copying and rehashing have succeeded.
 */
export class TermContentMetadataArena {
    /**
     * @param {number} denseCapacity
     * @param {number} slotCapacity
     * @throws {RangeError} If the layout cannot fit in a WASM32 memory.
     */
    constructor(denseCapacity, slotCapacity) {
        if (
            !Number.isSafeInteger(denseCapacity) || denseCapacity < 0 ||
            !Number.isSafeInteger(slotCapacity) || slotCapacity < 0
        ) {
            throw new RangeError('Invalid term content metadata arena capacity');
        }
        let offset = TABLE_START;
        /**
         * @param {number} count
         * @param {number} width
         * @returns {number}
         */
        const reserve = (count, width) => {
            offset = Math.ceil(offset / width) * width;
            const start = offset;
            offset += count * width;
            return start;
        };
        const slots = reserve(slotCapacity, 4);
        const hash1 = reserve(denseCapacity, 4);
        const hash2 = reserve(denseCapacity, 4);
        const state = reserve(denseCapacity, 1);
        const length = reserve(denseCapacity, 4);
        const signaturePresent = reserve(denseCapacity, 1);
        const signature1 = reserve(denseCapacity, 4);
        const signature2 = reserve(denseCapacity, 4);
        const signature3 = reserve(denseCapacity, 4);
        const pages = Math.ceil(offset / WASM_PAGE_BYTES);
        if (!Number.isSafeInteger(offset) || offset > 0xffffffff) {
            throw new RangeError('Term content metadata arena exceeds WASM32 bounds');
        }
        /** @type {WebAssembly.Memory} */
        this.memory = new WebAssembly.Memory({initial: pages, maximum: pages});
        const buffer = this.memory.buffer;
        /** @type {Uint32Array} */
        this.slots = new Uint32Array(buffer, slots, slotCapacity);
        /** @type {Uint32Array} */
        this.hash1 = new Uint32Array(buffer, hash1, denseCapacity);
        /** @type {Uint32Array} */
        this.hash2 = new Uint32Array(buffer, hash2, denseCapacity);
        /** @type {Uint8Array} */
        this.state = new Uint8Array(buffer, state, denseCapacity);
        /** @type {Uint32Array} */
        this.length = new Uint32Array(buffer, length, denseCapacity);
        /** @type {Uint8Array} */
        this.signaturePresent = new Uint8Array(buffer, signaturePresent, denseCapacity);
        /** @type {Uint32Array} */
        this.signature1 = new Uint32Array(buffer, signature1, denseCapacity);
        /** @type {Uint32Array} */
        this.signature2 = new Uint32Array(buffer, signature2, denseCapacity);
        /** @type {Uint32Array} */
        this.signature3 = new Uint32Array(buffer, signature3, denseCapacity);
    }

    /**
     * Copies dense columns while preserving stable IDs. Slot coordinates are
     * valid only at the same capacity; callers rebuild them when it changes.
     * @param {TermContentMetadataArena} previous
     */
    copyFrom(previous) {
        this.hash1.set(previous.hash1);
        this.hash2.set(previous.hash2);
        this.state.set(previous.state);
        this.length.set(previous.length);
        this.signaturePresent.set(previous.signaturePresent);
        this.signature1.set(previous.signature1);
        this.signature2.set(previous.signature2);
        this.signature3.set(previous.signature3);
        if (this.slots.length === previous.slots.length) {
            this.slots.set(previous.slots);
        }
    }
}
