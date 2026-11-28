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

import {hashTermKeyBytes} from './term-key-hash.js'

const INPUT_BYTES = 65536
const MEMORY_BYTES = 131072
const MAX_INPUT_BYTES = 0xffffffff

/** @typedef {{nativeHashCallCount: number, nativeHashBytes: number}} TermIndexHashMetrics */
/** @typedef {{memory: WebAssembly.Memory, input_pointer: () => number, input_capacity: () => number, hash_abi_version: () => number, reset: (length: number) => void, update: (length: number) => void, digest: (tailLength: number) => number}} TermIndexHashExports */
/** @type {Promise<boolean>|null} */
let initialization = null
/** @type {((bytes: Uint8Array) => number)|null} */
let nativeHash = null

/**
 * Starts optional fixed-memory checksum initialization alongside import setup.
 * Failed fetches, unsupported SIMD and incompatible modules retain the ordinary
 * JavaScript hash. The returned promise always handles its rejection.
 * @returns {Promise<boolean>} Whether the native implementation became available.
 */
export function initializeTermIndexHash() {
    if (initialization === null) {
        initialization = loadNativeHash().then((hash) => {
            nativeHash = hash
            return true
        }, () => {
            initialization = null
            return false
        })
    }
    return initialization
}

/**
 * Computes the persisted XXH32 checksum at its existing synchronous boundary.
 * No source alias or cached checksum survives the call. Small, shared, resizable or
 * nonordinary views retain the JavaScript implementation and its semantics.
 * @param {Uint8Array} bytes
 * @param {TermIndexHashMetrics|null} [metrics]
 * @returns {number}
 */
export function hashTermIndexBytes(bytes, metrics = null) {
    const hash = nativeHash
    if (
        hash !== null && Object.getPrototypeOf(bytes) === Uint8Array.prototype &&
        !Object.hasOwn(bytes, 'buffer') && !Object.hasOwn(bytes, 'byteOffset') &&
        !Object.hasOwn(bytes, 'byteLength') &&
        bytes.byteLength >= INPUT_BYTES && bytes.byteLength <= MAX_INPUT_BYTES &&
        bytes.buffer instanceof ArrayBuffer && Reflect.get(bytes.buffer, 'resizable') !== true
    ) {
        try {
            const result = hash(bytes)
            if (metrics !== null) {
                ++metrics.nativeHashCallCount
                metrics.nativeHashBytes += bytes.byteLength
            }
            return result
        } catch {
            // Nothing is published until this checksum returns. A failed
            // optional accelerator can safely retry the unchanged bytes in JS.
            nativeHash = null
            initialization = null
        }
    }
    return hashTermKeyBytes(bytes)
}

/**
 * @returns {Promise<(bytes: Uint8Array) => number>}
 * @throws {Error} If the optional module cannot supply the fixed private ABI.
 */
async function loadNativeHash() {
    const response = await fetch(new URL('../../lib/term-index-hash-v1.wasm', import.meta.url))
    if (!response.ok) { throw new Error('Failed to load term-index checksum WASM') }
    const {instance} = await WebAssembly.instantiate(await response.arrayBuffer())
    const exports = /** @type {TermIndexHashExports} */ (instance.exports)
    const {
        memory, input_pointer: inputPointer, input_capacity: inputCapacity,
        hash_abi_version: abiVersion, reset, update, digest,
    } = exports
    if (
        !(memory instanceof WebAssembly.Memory) || !(memory.buffer instanceof ArrayBuffer) ||
        memory.buffer.byteLength !== MEMORY_BYTES ||
        typeof inputPointer !== 'function' || typeof inputCapacity !== 'function' ||
        typeof abiVersion !== 'function' || typeof reset !== 'function' ||
        typeof update !== 'function' || typeof digest !== 'function' ||
        abiVersion() !== 1 || inputCapacity() !== INPUT_BYTES
    ) {
        throw new Error('Incompatible term-index checksum WASM')
    }
    const pointer = inputPointer()
    if (!Number.isInteger(pointer) || pointer < 0 || pointer > MEMORY_BYTES - INPUT_BYTES) {
        throw new Error('Invalid term-index checksum workspace')
    }
    const input = new Uint8Array(memory.buffer, pointer, INPUT_BYTES)
    return (bytes) => {
        const length = bytes.byteLength
        const buffer = bytes.buffer
        const sourceOffset = bytes.byteOffset
        reset(length)
        // Do not narrow the cursor: valid byte lengths can exceed 2^31.
        const end = length - length % 16
        let offset = 0
        while (offset < end) {
            const count = Math.min(end - offset, INPUT_BYTES)
            input.set(new Uint8Array(buffer, sourceOffset + offset, count))
            update(count)
            offset += count
        }
        if (offset < length) { input.set(new Uint8Array(buffer, sourceOffset + offset, length - offset)) }
        return digest(length - offset) >>> 0
    }
}
