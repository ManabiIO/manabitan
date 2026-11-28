/* SPDX-License-Identifier: GPL-3.0-or-later */

import {hashTermKeyByteRange} from '../../../ext/js/dictionary/term-key-hash.js'

const Uint8 = Uint8Array
const uint8Prototype = Uint8.prototype
const typedPrototype = Object.getPrototypeOf(uint8Prototype)
const getPrototypeOf = Object.getPrototypeOf
const hasOwn = Object.hasOwn
const apply = Reflect.apply
const isView = ArrayBuffer.isView
const isInteger = Number.isInteger
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get
const getByteOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get
const getByteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get
const getBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const setBytes = uint8Prototype.set

// Prototype only: initialize outside the synchronous checksum call. No module
// cache, dictionary-sized copy, caller-supplied callbacks, or hash cache exists.
export async function createNativeChecksum(wasmBytes, minimumBytes = 1024) {
    const {instance} = await WebAssembly.instantiate(wasmBytes)
    const native = instance.exports
    const memory = native.memory.buffer
    const capacity = native.xxh32_scratch_capacity()
    const scratch = new Uint8(memory, native.xxh32_scratch_ptr(), capacity)
    if (memory.byteLength !== 65536 || capacity !== 61440) throw new Error('Unexpected checksum memory layout')

    function hashByteRange(bytes, start, end) {
        if (!isInteger(start) || !isInteger(end)) return hashTermKeyByteRange(bytes, start, end)
        const length = end - start
        if (
            length < minimumBytes || start < 0 ||
            !isView(bytes) || getPrototypeOf(bytes) !== uint8Prototype ||
            hasOwn(bytes, 'buffer') || hasOwn(bytes, 'byteOffset') || hasOwn(bytes, 'byteLength')
        ) return hashTermKeyByteRange(bytes, start, end)

        const buffer = apply(getBuffer, bytes, [])
        const byteOffset = apply(getByteOffset, bytes, [])
        const byteLength = apply(getByteLength, bytes, [])
        if (end > byteLength || buffer === memory) return hashTermKeyByteRange(bytes, start, end)
        try {
            // Shared and resizable backing stores retain the existing reader.
            apply(getBufferByteLength, buffer, [])
            if (getResizable && apply(getResizable, buffer, [])) return hashTermKeyByteRange(bytes, start, end)
        } catch {
            return hashTermKeyByteRange(bytes, start, end)
        }

        native.xxh32_init(0x811c9dc5)
        for (let offset = start; offset < end;) {
            const remaining = end - offset
            const count = remaining < capacity ? remaining : capacity
            // A direct view cannot invoke source.constructor/Symbol.species.
            const source = new Uint8(buffer, byteOffset + offset, count)
            apply(setBytes, scratch, [source])
            if (native.xxh32_update(count) !== 1) throw new Error('Checksum update rejected')
            offset += count
        }
        return native.xxh32_finish() >>> 0
    }

    return {
        hashByteRange,
        hashBytes: (bytes) => hashByteRange(bytes, 0, bytes.byteLength),
        memoryBytes: memory.byteLength,
        scratchBytes: capacity,
    }
}
