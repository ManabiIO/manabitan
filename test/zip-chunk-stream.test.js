/*
 * Copyright (C) 2023-2026  Yomitan Authors
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

import {describe, expect, test} from 'vitest'
import {ChunkStream} from '../dev/zip-chunk-stream.js'

/**
 * @param {Uint8Array[]} inputs
 * @param {number} chunkSize
 * @returns {Promise<Uint8Array[]>}
 */
async function collectTransferredChunks(inputs, chunkSize) {
    /** @type {Uint8Array[]} */
    const outputs = []
    const source = new ReadableStream({
        start(controller) {
            for (const input of inputs) { controller.enqueue(input) }
            controller.close()
        },
    })
    await source.pipeThrough(new ChunkStream(chunkSize)).pipeTo(new WritableStream({
        write(chunk) {
            // Exercise the worker protocol: each output is detached immediately.
            outputs.push(structuredClone(chunk, {transfer: [chunk.buffer]}))
            expect(chunk.byteLength).toBe(0)
        },
    }))
    return outputs
}

/**
 * @param {number} length
 * @returns {Uint8Array}
 */
function bytes(length) {
    return Uint8Array.from({length}, (_, i) => (i * 31 + (i >>> 8)) & 255)
}

describe('ZIP output splitting', () => {
    test.each([1, 2, 3, 7, 64, 1024, 65536])('preserves bytes, boundaries, and ownership at size %i', async (size) => {
        const source = bytes(size * 4 + 13)
        // Nonzero byte offsets and empty inputs exercise both seam paths.
        const backing = new Uint8Array(source.length + 14)
        backing.set(source, 7)
        const view = backing.subarray(7, 7 + source.length)
        const splits = [0, 1, Math.min(size + 1, view.length), Math.min(size * 2 + 2, view.length), view.length]
        const inputs = [new Uint8Array(0)]
        for (let i = 1; i < splits.length; i++) {
            inputs.push(view.subarray(splits[i - 1], splits[i]), new Uint8Array(0))
        }
        const outputs = await collectTransferredChunks(inputs, size)
        const flattened = Buffer.concat(outputs)
        expect(flattened.equals(Buffer.from(source))).toBe(true)
        expect(outputs.map((chunk) => chunk.length)).toEqual(
            Array.from({length: Math.ceil(source.length / size)}, (_, i) => Math.min(size, source.length - i * size)),
        )
        expect(backing.byteLength).toBe(source.length + 14)
        expect(Buffer.from(view).equals(Buffer.from(source))).toBe(true)
        expect(new Set(outputs.map((chunk) => chunk.buffer)).size).toBe(outputs.length)
    })

    test.each([[], [new Uint8Array(0)], [new Uint8Array(0), new Uint8Array(0)]])('does not emit empty chunks: %j', async (...inputs) => {
        // Vitest spreads each table row into arguments.
        const outputs = await collectTransferredChunks(inputs, 8)
        expect(outputs).toEqual([])
    })

    test('keeps the full pending chunk until further data or flush', async () => {
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

    test('splits a large single input without recursive tail copies', async () => {
        const input = bytes(8 * 1024 * 1024 + 3)
        const output = await collectTransferredChunks([input], 1024)
        expect(Buffer.concat(output).equals(Buffer.from(input))).toBe(true)
        expect(output).toHaveLength(8193)
        expect(output.at(-1)?.length).toBe(3)
    })

    test('handles deterministic fragmented input across many seams', async () => {
        let seed = 0x5f3759df
        const random = () => {
            seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
            return seed
        }
        for (let caseIndex = 0; caseIndex < 100; caseIndex++) {
            const size = 1 + random() % 257
            const input = bytes(random() % 8192)
            const chunks = []
            for (let offset = 0; offset < input.length;) {
                const length = 1 + random() % 513
                chunks.push(input.subarray(offset, offset + length))
                if (random() % 3 === 0) { chunks.push(new Uint8Array(0)) }
                offset += length
            }
            const output = await collectTransferredChunks(chunks, size)
            expect(Buffer.concat(output).equals(Buffer.from(input))).toBe(true)
            expect(output.map((chunk) => chunk.length)).toEqual(
                Array.from({length: Math.ceil(input.length / size)}, (_, i) => Math.min(size, input.length - i * size)),
            )
        }
    })

    test.each([0, -1, 1.5, Number.NaN, Infinity])('rejects invalid internal chunk size %s', (size) => {
        expect(() => new ChunkStream(size)).toThrow(RangeError)
    })
})
