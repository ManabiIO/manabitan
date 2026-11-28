/* SPDX-License-Identifier: GPL-3.0-or-later */
import {hashTermKeyBytes} from '../../../ext/js/dictionary/term-key-hash.js'

const Uint8 = Uint8Array
const uint8Prototype = Uint8.prototype
const typedPrototype = Object.getPrototypeOf(uint8Prototype)
const getPrototypeOf = Object.getPrototypeOf
const hasOwn = Object.hasOwn
const apply = Reflect.apply
const isView = ArrayBuffer.isView
const getBuffer = Object.getOwnPropertyDescriptor(typedPrototype, 'buffer').get
const getByteOffset = Object.getOwnPropertyDescriptor(typedPrototype, 'byteOffset').get
const getByteLength = Object.getOwnPropertyDescriptor(typedPrototype, 'byteLength').get
const getBufferByteLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get
const getResizable = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get
const setBytes = uint8Prototype.set

export const hashThreeJavascript = (a, b, c) => [hashTermKeyBytes(a), hashTermKeyBytes(b), hashTermKeyBytes(c)]

export async function createThreeStreamChecksum(wasmBytes) {
    const {instance} = await WebAssembly.instantiate(wasmBytes)
    const native = instance.exports
    const memory = native.memory.buffer
    const capacity = native.xxh32_scratch_capacity()
    if (memory.byteLength !== 65536 || capacity !== 20480) throw new Error('Unexpected triple-stream memory layout')
    const pointer = native.xxh32_scratch_ptr()
    const scratch0 = new Uint8(memory, pointer, capacity)
    const scratch1 = new Uint8(memory, pointer + capacity, capacity)
    const scratch2 = new Uint8(memory, pointer + capacity * 2, capacity)

    function admit(bytes) {
        if (!isView(bytes) || getPrototypeOf(bytes) !== uint8Prototype || hasOwn(bytes, 'buffer') ||
            hasOwn(bytes, 'byteOffset') || hasOwn(bytes, 'byteLength')) return null
        const buffer = apply(getBuffer, bytes, [])
        if (buffer === memory) return null
        try {
            apply(getBufferByteLength, buffer, [])
            if (getResizable && apply(getResizable, buffer, [])) return null
        } catch {
            return null
        }
        return {buffer, offset: apply(getByteOffset, bytes, []), length: apply(getByteLength, bytes, [])}
    }

    function hashThree(a, b, c) {
        const x = admit(a)
        const y = admit(b)
        const z = admit(c)
        if (x === null || y === null || z === null || x.length + y.length + z.length < 3072) return hashThreeJavascript(a, b, c)
        native.xxh32_init(0x811c9dc5)
        let xOffset = 0
        let yOffset = 0
        let zOffset = 0
        while (xOffset < x.length || yOffset < y.length || zOffset < z.length) {
            const xRemaining = x.length - xOffset
            const yRemaining = y.length - yOffset
            const zRemaining = z.length - zOffset
            const xCount = xRemaining < capacity ? xRemaining : capacity
            const yCount = yRemaining < capacity ? yRemaining : capacity
            const zCount = zRemaining < capacity ? zRemaining : capacity
            if (xCount > 0) apply(setBytes, scratch0, [new Uint8(x.buffer, x.offset + xOffset, xCount)])
            if (yCount > 0) apply(setBytes, scratch1, [new Uint8(y.buffer, y.offset + yOffset, yCount)])
            if (zCount > 0) apply(setBytes, scratch2, [new Uint8(z.buffer, z.offset + zOffset, zCount)])
            if (native.xxh32_update(xCount, yCount, zCount) !== 1) throw new Error('Triple checksum update rejected')
            xOffset += xCount
            yOffset += yCount
            zOffset += zCount
        }
        return [native.xxh32_finish(0) >>> 0, native.xxh32_finish(1) >>> 0, native.xxh32_finish(2) >>> 0]
    }
    return {hashThree, memoryBytes: memory.byteLength, capacityPerStream: capacity}
}
