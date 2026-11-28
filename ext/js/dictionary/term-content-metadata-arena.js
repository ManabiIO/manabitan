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

import {TERM_CONTENT_METADATA_PREFIX_BYTES} from './term-content-canonical-layout.js';

const WASM_PAGE_BYTES = 65536;

export const TERM_CONTENT_SIGNATURE1_MBR6 = 0x3652424d;

// Fixed scratch reservation shared with the native canonical scanner.
// Each replacement memory remains fixed; retained views never detach.
const TABLE_START = TERM_CONTENT_METADATA_PREFIX_BYTES;

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
        // The common MBR6 first word is represented by presence marker 2.
        // A rare materialized column is external to the fixed native memory.
        /** @type {Uint32Array|null} */
        this.signature1 = null;
        /** @type {Uint32Array} */
        this.signature2 = new Uint32Array(buffer, signature2, denseCapacity);
        /** @type {Uint32Array} */
        this.signature3 = new Uint32Array(buffer, signature3, denseCapacity);
    }

    /**
     * Reads the exact former first-word column, including unused/free entries.
     * @param {number} index
     * @returns {number|undefined}
     */
    getSignature1(index) {
        if (!Number.isInteger(index) || index < 0 || index >= this.state.length) { return void 0; }
        if (this.signaturePresent[index] === 2) { return TERM_CONTENT_SIGNATURE1_MBR6; }
        return this.signature1 === null ? 0 : this.signature1[index];
    }

    /**
     * Empty/free entries can retain an old MBR6 word, so every implicit slot
     * participates, not only live IDs. Leave markers unchanged: accepted byte
     * sources can alias this arena, and allocation must not mutate their bytes.
     * @returns {Uint32Array}
     */
    materializeSignature1() {
        if (this.signature1 !== null) { return this.signature1; }
        const table = new Uint32Array(this.state.length);
        for (let i = 0; i < table.length; ++i) {
            if (this.signaturePresent[i] === 2) { table[i] = TERM_CONTENT_SIGNATURE1_MBR6; }
        }
        this.signature1 = table;
        return table;
    }

    /* eslint-disable @stylistic/semi */
    /**
     * Copies dense columns while preserving stable IDs. Slot coordinates are
     * valid only at the same capacity; callers rebuild them when it changes.
     * @param {TermContentMetadataArena} previous
     * @param {number} [denseCount=previous.state.length] Allocated ID high-water mark, including reusable empty IDs.
     * @param {boolean} [preserveSlots=true]
     * @throws {RangeError} If the live prefix exceeds either arena.
     */
    copyFrom(previous, denseCount = previous.state.length, preserveSlots = true) {
        if (
            !Number.isSafeInteger(denseCount) || denseCount < 0 ||
            denseCount > previous.state.length || denseCount > this.state.length
        ) {
            throw new RangeError('Invalid term content metadata dense count')
        }
        this.hash1.set(previous.hash1.subarray(0, denseCount))
        this.hash2.set(previous.hash2.subarray(0, denseCount))
        this.state.set(previous.state.subarray(0, denseCount))
        this.length.set(previous.length.subarray(0, denseCount))
        this.signaturePresent.set(previous.signaturePresent.subarray(0, denseCount))
        if (previous.signature1 !== null || this.signature1 !== null) {
            const signature1 = this.signature1 ?? new Uint32Array(this.state.length)
            if (previous.signature1 === null) {
                signature1.fill(0, 0, denseCount)
            } else {
                signature1.set(previous.signature1.subarray(0, denseCount))
            }
            for (let i = 0; i < denseCount; ++i) {
                if (this.signaturePresent[i] === 2) { signature1[i] = TERM_CONTENT_SIGNATURE1_MBR6 }
            }
            this.signature1 = signature1
        }
        this.signature2.set(previous.signature2.subarray(0, denseCount))
        this.signature3.set(previous.signature3.subarray(0, denseCount))
        if (preserveSlots && this.slots.length === previous.slots.length) {
            this.slots.set(previous.slots)
        }
    }
    /* eslint-enable @stylistic/semi */
}
