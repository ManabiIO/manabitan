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

import {RetryablePromiseCache} from '../core/retryable-promise-cache.js'

const moduleCache = new RetryablePromiseCache()
const pageBytes = 65536
const maxInputBytes = 16 * 1024 * 1024
const initialPages = 2
const maximumPages = initialPages + maxInputBytes / pageBytes
/* eslint-disable @typescript-eslint/unbound-method */
const arrayBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')?.get
const typedArrayTag = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), Symbol.toStringTag)?.get
/* eslint-enable @typescript-eslint/unbound-method */

class ImportLookupChecksum {
    /** @type {{memory: WebAssembly.Memory, hash: (pointer: number, length: number) => number, pointer: number, scratch: Uint8Array}|null} */
    #state

    /**
     * @param {WebAssembly.Memory} memory
     * @param {(pointer: number, length: number) => number} hash
     * @param {number} pointer
     */
    constructor(memory, hash, pointer) {
        /** @type {{memory: WebAssembly.Memory, hash: (pointer: number, length: number) => number, pointer: number, scratch: Uint8Array}|null} */
        this.#state = {memory, hash, pointer, scratch: new Uint8Array(memory.buffer, pointer)}
    }

    /**
     * Hash a fresh copy of the exact current view. Shared or unusual views keep
     * the existing JS behavior; the private scratch never escapes this object.
     * @param {Uint8Array} bytes
     * @returns {number|null} Null selects the existing JavaScript checksum.
     */
    hash(bytes) {
        const state = this.#state
        if (
            state === null || !ArrayBuffer.isView(bytes) || Object.getPrototypeOf(bytes) !== Uint8Array.prototype ||
            Object.hasOwn(bytes, 'length') || Object.hasOwn(bytes, 'byteLength') ||
            Object.hasOwn(bytes, 'buffer') || Object.hasOwn(bytes, 'byteOffset') ||
            typedArrayTag?.call(bytes) !== 'Uint8Array' || typeof arrayBufferByteLength !== 'function'
        ) { return null }
        try {
            // The intrinsic rejects SharedArrayBuffer, including a changed prototype.
            arrayBufferByteLength.call(bytes.buffer)
        } catch {
            return null
        }
        const length = bytes.byteLength
        if (length > maxInputBytes) { return null }
        try {
            if (length > state.scratch.byteLength) {
                let capacity = pageBytes
                while (capacity < length) { capacity *= 2 }
                const requiredPages = Math.ceil((state.pointer + capacity) / pageBytes)
                state.memory.grow(requiredPages - state.memory.buffer.byteLength / pageBytes)
                state.scratch = new Uint8Array(state.memory.buffer, state.pointer)
            }
            state.scratch.set(bytes)
            return state.hash(state.pointer, length) >>> 0
        } catch {
            // An unavailable allocator or native instance must not fail an import.
            this.dispose()
            return null
        }
    }

    /** @returns {void} */
    dispose() {
        this.#state = null
    }
}

/**
 * Optional per-import acceleration. Only the immutable compiled module is
 * shared between sessions; fetch/compile failure remains retryable.
 * @returns {Promise<ImportLookupChecksum|null>}
 */
export async function createImportLookupChecksum() {
    try {
        const module = await moduleCache.get(async () => {
            const response = await fetch(new URL('../../lib/term-record-checksum.wasm', import.meta.url))
            if (!response.ok) { throw new Error('Lookup checksum module is unavailable') }
            const result = await WebAssembly.compile(await response.arrayBuffer())
            const imports = WebAssembly.Module.imports(result)
            if (imports.length !== 1 || imports[0].module !== 'env' || imports[0].name !== 'memory' || imports[0].kind !== 'memory') {
                throw new Error('Invalid lookup checksum memory import')
            }
            const exports = WebAssembly.Module.exports(result)
            if (
                !exports.some(({name, kind}) => name === 'hash_lookup_index_bytes' && kind === 'function') ||
                !exports.some(({name, kind}) => name === '__heap_base' && kind === 'global')
            ) {
                throw new Error('Invalid lookup checksum exports')
            }
            return result
        })
        const memory = new WebAssembly.Memory({initial: initialPages, maximum: maximumPages})
        const {exports} = await WebAssembly.instantiate(module, {env: {memory}})
        const {__heap_base: heapBase} = exports
        /** @type {unknown} */
        const pointer = heapBase instanceof WebAssembly.Global ? heapBase.value : null
        if (
            typeof exports.hash_lookup_index_bytes !== 'function' || typeof pointer !== 'number' ||
            !Number.isSafeInteger(pointer) || pointer < pageBytes || pointer >= initialPages * pageBytes
        ) { return null }
        return new ImportLookupChecksum(
            memory,
            /** @type {(pointer: number, length: number) => number} */ (exports.hash_lookup_index_bytes),
            pointer,
        )
    } catch {
        return null
    }
}
