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

import {describe, expect, test} from 'vitest'
import {ChunkStream} from '../dev/zip-chunk-stream.js'

/**
 * Independent reference for the exact pinned 2.7.54 stream protocol. Its
 * recursive tail copies are intentionally retained only in this test.
 * @augments {TransformStream<Uint8Array, Uint8Array>}
 */
class PinnedChunkStream extends TransformStream {
    /** @param {number} size */
    constructor(size) {
        /** @type {Uint8Array|null} */
        let pending = null
        /**
         * @param {Uint8Array} chunk
         * @param {TransformStreamDefaultController<Uint8Array>} controller
         */
        function transform(chunk, controller) {
            if (pending !== null) {
                const joined = new Uint8Array(pending.length + chunk.length)
                joined.set(pending)
                joined.set(chunk, pending.length)
                chunk = joined
                pending = null
            }
            if (chunk.length > size) {
                controller.enqueue(chunk.slice(0, size))
                transform(chunk.slice(size), controller)
            } else {
                pending = chunk
            }
        }
        super({
            transform,
            flush(controller) {
                if (pending !== null && pending.length > 0) { controller.enqueue(pending) }
            },
        })
    }
}

/**
 * @param {typeof ChunkStream} Constructor
 * @param {Uint8Array[]} inputs
 * @param {number} size
 * @param {boolean} [transfer]
 */
async function collect(Constructor, inputs, size, transfer = false) {
    /** @type {Uint8Array[]} */
    const outputs = []
    const source = new ReadableStream({
        start(controller) {
            for (const input of inputs) { controller.enqueue(input) }
            controller.close()
        },
    })
    await source.pipeThrough(new Constructor(size)).pipeTo(new WritableStream({
        write(chunk) {
            outputs.push(transfer ? structuredClone(chunk, {transfer: [chunk.buffer]}) : chunk)
        },
    }))
    return outputs
}

/** @param {number} length */
function bytes(length) {
    return Uint8Array.from({length}, (_, i) => (i * 31 + (i >>> 8)) & 255)
}

describe('linear ZIP splitting with original small-buffer behavior', () => {
    test.each([1, 7, 63, 64])('retains the zero-copy single-input path at length %i', async (length) => {
        const source = new Uint8Array(new ArrayBuffer(length + 29), 13, length)
        source.set(bytes(length))
        const result = await collect(ChunkStream, [source], 64)
        expect(result).toHaveLength(1)
        expect(result[0]).toBe(source)
        expect(result[0].buffer).toBe(source.buffer)
        expect(result[0].byteOffset).toBe(13)
    })

    test('allocates only the exact combined length for two small inputs', async () => {
        const first = bytes(3)
        const second = bytes(5)
        const result = await collect(ChunkStream, [first, second], 65536)
        expect(result).toHaveLength(1)
        expect(result[0].buffer.byteLength).toBe(8)
        expect([...result[0]]).toEqual([...first, ...second])
        expect(result[0].buffer).not.toBe(first.buffer)
        expect(result[0].buffer).not.toBe(second.buffer)
    })

    test.each([1, 2, 7, 64, 1024, 65536])('matches all reference chunk boundaries at size %i', async (size) => {
        const source = bytes(size * 4 + 13)
        const offsets = [0, 1, size + 1, size * 2 + 2, source.length]
        const inputs = [new Uint8Array(0)]
        for (let i = 1; i < offsets.length; ++i) {
            inputs.push(source.subarray(offsets[i - 1], offsets[i]), new Uint8Array(0))
        }
        const expected = await collect(PinnedChunkStream, inputs, size)
        const actual = await collect(ChunkStream, inputs, size)
        expect(actual.map((chunk) => [...chunk])).toEqual(expected.map((chunk) => [...chunk]))
        expect(Buffer.concat(actual).equals(Buffer.from(source))).toBe(true)
    })

    test('preserves the full pending chunk until further data or flush', async () => {
        const stream = new ChunkStream(4)
        const reader = stream.readable.getReader()
        const writer = stream.writable.getWriter()
        let delivered = false
        const first = reader.read().then((result) => {
            delivered = true
            return result
        })
        await writer.write(new Uint8Array([1, 2, 3, 4]))
        await writer.write(new Uint8Array(0))
        expect(delivered).toBe(false)
        await writer.write(new Uint8Array([5]))
        expect((await first).value).toEqual(new Uint8Array([1, 2, 3, 4]))
        const last = reader.read()
        await writer.close()
        expect((await last).value).toEqual(new Uint8Array([5]))
        expect((await reader.read()).done).toBe(true)
    })

    test('gives split outputs independent ownership for immediate transfer', async () => {
        const input = bytes(8 * 1024 * 1024 + 3)
        const result = await collect(ChunkStream, [input], 1024, true)
        expect(result).toHaveLength(8193)
        expect(result.at(-1)?.length).toBe(3)
        expect(new Set(result.map((chunk) => chunk.buffer)).size).toBe(result.length)
        expect(Buffer.concat(result).equals(Buffer.from(input))).toBe(true)
        expect(input.byteLength).toBe(8 * 1024 * 1024 + 3)
    })

    test('copies a large input once instead of copying shrinking tails', async () => {
        let copied = 0
        class CountingBytes extends Uint8Array {
            /**
             * @param {number} [start]
             * @param {number} [end]
             */
            slice(start = 0, end = this.length) {
                copied += end - start
                return super.slice(start, end)
            }
        }
        const source = new CountingBytes(4 * 1024 * 1024 + 7)
        source.set(bytes(source.length))
        const expected = await collect(PinnedChunkStream, [source], 65536)
        const oldCopied = copied
        copied = 0
        const actual = await collect(ChunkStream, [source], 65536)
        expect(copied).toBe(source.length)
        expect(oldCopied).toBeGreaterThan(copied * 30)
        expect(Buffer.concat(actual).equals(Buffer.concat(expected))).toBe(true)
    })

    test('does not emit empty inputs or an empty stream', async () => {
        for (const inputs of [[], [new Uint8Array(0)], [new Uint8Array(0), new Uint8Array(0)]]) {
            expect(await collect(ChunkStream, inputs, 8)).toEqual([])
        }
    })

    test('matches the pinned reference across deterministic fragmented inputs', async () => {
        let seed = 0x4af51392
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed
        }
        for (let i = 0; i < 300; ++i) {
            const source = bytes(random() % 4096)
            const size = 1 + random() % 257
            const inputs = []
            for (let offset = 0; offset < source.length;) {
                const next = offset + 1 + random() % 513
                inputs.push(source.subarray(offset, next))
                if (random() % 3 === 0) { inputs.push(new Uint8Array(0)) }
                offset = next
            }
            const expected = await collect(PinnedChunkStream, inputs, size)
            const actual = await collect(ChunkStream, inputs, size)
            expect(actual.map((chunk) => [...chunk])).toEqual(expected.map((chunk) => [...chunk]))
        }
    })

    test.each([0, -1, 1.5, Number.NaN, Infinity])('rejects invalid internal chunk size %s', (size) => {
        expect(() => new ChunkStream(size)).toThrow(RangeError)
    })
})
