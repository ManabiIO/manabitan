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
/* eslint @stylistic/semi: ["error", "never"] */

import assert from 'node:assert/strict'
import {once} from 'node:events'
import {createServer} from 'node:http'
import {test} from 'node:test'
import {gzipSync} from 'node:zlib'
import {RequestBuilder} from '../../ext/js/background/request-builder.js'

/**
 * @param {number[][]} chunks
 * @param {string|null} length
 * @returns {Response}
 */
function makeResponse(chunks, length) {
    return new Response(new ReadableStream({
        start(controller) {
            for (const chunk of chunks) { controller.enqueue(Uint8Array.from(chunk)) }
            controller.close()
        },
    }), {headers: length === null ? {} : {'Content-Length': length}})
}

for (const {name, chunks, length} of [
    {name: 'first chunk exceeds header', chunks: [[1, 2, 3, 4]], length: '2'},
    {name: 'partial prefix then overflow', chunks: [[1, 2], [3, 4, 5, 6]], length: '3'},
    {name: 'exactly full prefix then overflow', chunks: [[1, 2, 3], [4, 5]], length: '3'},
    {name: 'later chunks after overflow', chunks: [[1, 2], [3, 4, 5], [6], [7, 8]], length: '4'},
    {name: 'multiple chunks after first chunk overflows', chunks: [[1, 2, 3], [4, 5]], length: '1'},
    {name: 'zero length header with nonempty data', chunks: [[1, 2], [3]], length: '0'},
    {name: 'zero-byte chunks around overflow', chunks: [[], [1, 2], [], [3, 4], []], length: '3'},
    {name: 'exact length', chunks: [[1, 2], [3]], length: '3'},
    {name: 'overstated length', chunks: [[1, 2], [3]], length: '8'},
    {name: 'missing length', chunks: [[1, 2], [3]], length: null},
    {name: 'nonnumeric length', chunks: [[1, 2], [3]], length: 'unknown'},
    {name: 'empty stream without header', chunks: [], length: null},
    {name: 'empty stream with zero header', chunks: [], length: '0'},
    {name: 'empty stream with positive header', chunks: [], length: '3'},
]) {
    test(`stream bytes and progress: ${name}`, async () => {
        /** @type {boolean[]} */
        const progress = []
        const result = await RequestBuilder.readFetchResponseArrayBuffer(makeResponse(chunks, length), (done) => progress.push(done))
        assert.deepEqual(result, Uint8Array.from(chunks.flat()))
        assert.deepEqual(progress, [...chunks.map(() => false), true])
    })
}

test('overflow respects chunk view offsets and never includes backing-buffer sentinels', async () => {
    const storage = Uint8Array.from([99, 10, 20, 30, 40, 88])
    const response = new Response(new ReadableStream({
        start(controller) {
            controller.enqueue(storage.subarray(1, 3))
            controller.enqueue(storage.subarray(3, 5))
            controller.close()
        },
    }), {headers: {'Content-Length': '3'}})
    assert.deepEqual(await RequestBuilder.readFetchResponseArrayBuffer(response, () => {}), Uint8Array.from([10, 20, 30, 40]))
    assert.deepEqual(storage, Uint8Array.from([99, 10, 20, 30, 40, 88]))
})

test('omitting progress retains the native arrayBuffer path', async () => {
    assert.deepEqual(await RequestBuilder.readFetchResponseArrayBuffer(makeResponse([[1, 2, 3]], '1'), null), Uint8Array.from([1, 2, 3]))
})

test('null response body completes once', async () => {
    /** @type {boolean[]} */
    const progress = []
    const result = await RequestBuilder.readFetchResponseArrayBuffer(new Response(null), (done) => progress.push(done))
    assert.deepEqual(result, new Uint8Array())
    assert.deepEqual(progress, [true])
})

test('a stream error is propagated without successful completion', async () => {
    const error = new Error('Read failed')
    /** @type {boolean[]} */
    const progress = []
    const response = new Response(new ReadableStream({start(controller) { controller.error(error) }}))
    await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(response, (done) => progress.push(done)), (value) => value === error)
    assert.deepEqual(progress, [])
})

test('a progress callback error is propagated without returning partial bytes', async () => {
    const error = new Error('Progress failed')
    await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(makeResponse([[1, 2], [3]], '3'), () => { throw error }), (value) => value === error)
})

test('deterministic chunk partitions agree with independent concatenation at every header boundary', async () => {
    let comparisons = 0
    for (let mask = 0; mask < 64; ++mask) {
        /** @type {number[][]} */
        const chunks = [[]]
        for (let index = 0; index < 7; ++index) {
            chunks[chunks.length - 1].push(index + 1)
            if (index < 6 && (mask & (1 << index)) !== 0) { chunks.push([]) }
        }
        for (let length = 0; length <= 9; ++length) {
            const result = await RequestBuilder.readFetchResponseArrayBuffer(makeResponse(chunks, `${length}`), () => {})
            assert.deepEqual(result, Uint8Array.from([1, 2, 3, 4, 5, 6, 7]), `partition=${mask}, length=${length}`)
            ++comparisons
        }
    }
    assert.equal(comparisons, 640)
})

test('real HTTP gzip response preserves the complete automatically decoded body', async () => {
    const expected = Buffer.from('Manabitan streamed audio payload\n'.repeat(1000))
    const compressed = gzipSync(expected)
    const server = createServer((_request, response) => {
        response.writeHead(200, {'Content-Encoding': 'gzip', 'Content-Length': compressed.length})
        response.end(compressed)
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    try {
        const address = server.address()
        if (address === null || typeof address === 'string') { throw new Error('No HTTP server address') }
        const response = await fetch(`http://127.0.0.1:${address.port}/audio`)
        assert.equal(Number(response.headers.get('Content-Length')), compressed.length)
        assert.ok(expected.length > compressed.length)
        const actual = await RequestBuilder.readFetchResponseArrayBuffer(response, () => {})
        assert.equal(actual.length, expected.length)
        assert.ok(Buffer.from(actual).equals(expected), 'Decoded HTTP payload must match byte-for-byte')
    } finally {
        const closed = once(server, 'close')
        server.closeAllConnections()
        server.close()
        await closed
    }
})
