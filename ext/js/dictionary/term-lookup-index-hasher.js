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

import {compileCanonicalScanModule} from './term-content-canonical-scan.js';
import {hashTermKeyBytes} from './term-key-hash.js';

const SCRATCH_OFFSET = 131072;
const SCRATCH_BYTES = 65536;
const MEMORY_PAGES = 3;
const MIN_NATIVE_BYTES = 1024;
const getBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get;
const getBufferResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get;

/** @typedef {{hash: (bytes: Uint8Array) => number}} ImportLookupIndexHasher */
/**
 * @typedef {object} LookupHashExports
 * @property {() => number} lookup_hash_abi_version
 * @property {(length: number) => void} lookup_hash_begin
 * @property {(length: number) => void} lookup_hash_update
 * @property {(length: number) => number} lookup_hash_finish
 */

/**
 * Reuses immutable compiled code, never the canonical scanner's live memory.
 * The import owns this fixed 192 KiB instance and drops it on every exit.
 * @param {() => Promise<WebAssembly.Module>} [loadModule]
 * @returns {Promise<ImportLookupIndexHasher|null>}
 */
export async function createImportLookupIndexHasher(loadModule = compileCanonicalScanModule) {
    try {
        if (typeof WebAssembly === 'undefined') { return null; }
        const module = await loadModule();
        const memory = new WebAssembly.Memory({initial: MEMORY_PAGES, maximum: MEMORY_PAGES});
        const {exports} = new WebAssembly.Instance(module, {env: {memory}});
        if (
            typeof exports.lookup_hash_abi_version !== 'function' || exports.lookup_hash_abi_version() !== 1 ||
            typeof exports.lookup_hash_begin !== 'function' ||
            typeof exports.lookup_hash_update !== 'function' ||
            typeof exports.lookup_hash_finish !== 'function'
        ) { return null; }
        const native = /** @type {unknown} */ (exports);
        const {lookup_hash_begin: begin, lookup_hash_update: update, lookup_hash_finish: finish} = /** @type {LookupHashExports} */ (native);
        const scratch = new Uint8Array(memory.buffer, SCRATCH_OFFSET, SCRATCH_BYTES);
        let usable = true;
        return {
            hash(bytes) {
                // Keep the existing reader for unusual caller-owned views. No
                // getters, shared memory or resizes can reenter this native state.
                if (
                    !usable || !ArrayBuffer.isView(bytes) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
                    Object.hasOwn(bytes, 'buffer') || Object.hasOwn(bytes, 'byteLength') || Object.hasOwn(bytes, 'byteOffset')
                ) { return hashTermKeyBytes(bytes); }
                /** @type {ArrayBufferLike|undefined} */
                let buffer;
                let byteOffset = 0;
                let byteLength = 0;
                let eligible = false;
                try {
                    ({buffer, byteOffset, byteLength} = bytes);
                    // Intrinsic getters reject forged ArrayBuffer prototypes and
                    // ignore shadowed properties on the backing allocation.
                    eligible = (
                        typeof getBufferByteLength?.call(buffer) === 'number' &&
                        getBufferResizable?.call(buffer) !== true &&
                        byteLength >= MIN_NATIVE_BYTES && byteLength <= 0xffffffff
                    );
                } catch { /* Unusual storage retains the existing JS reader. */ }
                if (!eligible || typeof buffer === 'undefined') { return hashTermKeyBytes(bytes); }
                try {
                    begin(byteLength);
                    let cursor = 0;
                    while (byteLength - cursor > SCRATCH_BYTES) {
                        scratch.set(new Uint8Array(buffer, byteOffset + cursor, SCRATCH_BYTES));
                        update(SCRATCH_BYTES);
                        cursor += SCRATCH_BYTES;
                    }
                    const remaining = byteLength - cursor;
                    scratch.set(new Uint8Array(buffer, byteOffset + cursor, remaining));
                    return finish(remaining) >>> 0;
                } catch {
                    // A failed instance cannot affect persisted bytes: recompute
                    // from the current source and keep JS for this import.
                    usable = false;
                    return hashTermKeyBytes(bytes);
                }
            },
        };
    } catch {
        return null;
    }
}
