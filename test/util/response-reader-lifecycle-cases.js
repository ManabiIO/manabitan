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

import assert from 'node:assert/strict'
import {test} from 'node:test'
import {setImmediate as nextTurn} from 'node:timers/promises'
import {RequestBuilder} from '../../ext/js/background/request-builder.js'

/**
 * @param {number[][]} chunks
 * @param {string|null} length
 * @returns {{response: Response, stream: ReadableStream<Uint8Array>, cancellations: unknown[]}}
 */
function closedResponse(chunks, length) {
    /** @type {unknown[]} */
    const cancellations = []
    const stream = new ReadableStream({
        start(controller) {
            for (const chunk of chunks) { controller.enqueue(Uint8Array.from(chunk)) }
            controller.close()
        },
        cancel(reason) { cancellations.push(reason) },
    })
    const response = new Response(stream, {headers: length === null ? {} : {'Content-Length': length}})
    return {response, stream, cancellations}
}

for (const {label, chunks, length} of [
    {label: 'exact header', chunks: [[1], [2, 3]], length: '3'},
    {label: 'short header', chunks: [[1], [2, 3]], length: '1'},
    {label: 'long header', chunks: [[1], [2, 3]], length: '8'},
    {label: 'missing header', chunks: [[1], [2, 3]], length: null},
    {label: 'empty body', chunks: [], length: '0'},
    {label: 'empty chunks', chunks: [[], [1], [], [2, 3], []], length: '2'},
]) {
    test(`releases the response reader after success: ${label}`, async () => {
        const {response, stream, cancellations} = closedResponse(chunks, length)
        /** @type {boolean[]} */
        const progress = []
        const result = await RequestBuilder.readFetchResponseArrayBuffer(response, (done) => { progress.push(done) })
        assert.deepEqual(result, Uint8Array.from(chunks.flat()))
        // Progress represents transferred bytes, not empty stream chunks.
        assert.deepEqual(progress, [...chunks.filter((chunk) => chunk.length > 0).map(() => false), true])
        assert.equal(stream.locked, false)
        assert.deepEqual(cancellations, [])
        const nextReader = stream.getReader()
        assert.equal((await nextReader.read()).done, true)
        nextReader.releaseLock()
    })
}

test('accepts bodies larger than the speculative preallocation threshold', async () => {
    const size = (16 * 1024 * 1024) + 7
    const expected = new Uint8Array(size).fill(0x5a)
    expected[0] = 0x11
    expected[size - 1] = 0xee
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(expected)
            controller.close()
        },
    })
    const response = new Response(stream, {headers: {'Content-Length': String(size)}})
    const actual = await RequestBuilder.readFetchResponseArrayBuffer(response, () => {})
    assert.equal(actual.byteLength, size)
    assert.equal(actual[0], 0x11)
    assert.equal(actual[size >> 1], 0x5a)
    assert.equal(actual[size - 1], 0xee)
    assert.equal(stream.locked, false)
})

for (const reason of [new Error('progress failed'), 'literal failure', null]) {
    test(`cancels the unfinished body with the original progress error: ${String(reason)}`, async () => {
        /** @type {unknown[]} */
        const cancellations = []
        const stream = new ReadableStream({
            start(controller) { controller.enqueue(Uint8Array.from([1, 2])) },
            cancel(value) { cancellations.push(value) },
        })
        let callbacks = 0
        await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(new Response(stream), () => {
            ++callbacks
            throw reason
        }), (error) => error === reason)
        assert.equal(callbacks, 1)
        assert.deepEqual(cancellations, [reason])
        assert.equal(stream.locked, false)
    })
}

test('releases an errored stream without replacing its read error', async () => {
    const original = new Error('source failed')
    const stream = new ReadableStream({start(controller) { controller.error(original) }})
    let progress = 0
    await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(new Response(stream), () => { ++progress }), (error) => error === original)
    assert.equal(progress, 0)
    assert.equal(stream.locked, false)
    // reader.cancel() rejects again for an errored source; that rejection is owned.
    await nextTurn()
})

for (const length of ['-1', '3suffix', '9007199254740992']) {
    test(`treats Content-Length ${length} as an optional hint and still releases the reader`, async () => {
        const {response, stream, cancellations} = closedResponse([[1], [2, 3]], length)
        assert.deepEqual(
            await RequestBuilder.readFetchResponseArrayBuffer(response, () => {}),
            Uint8Array.from([1, 2, 3]),
        )
        assert.equal(stream.locked, false)
        assert.deepEqual(cancellations, [])
    })
}

for (const mode of ['throw', 'reject']) {
    test(`owns ${mode} cancellation failures without masking the progress error`, async () => {
        const original = new Error('progress failed')
        const cleanup = new Error('cleanup failed')
        let cancellations = 0
        const stream = new ReadableStream({
            start(controller) { controller.enqueue(Uint8Array.from([1])) },
            cancel() {
                ++cancellations
                if (mode === 'throw') { throw cleanup }
                return Promise.reject(cleanup)
            },
        })
        await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(new Response(stream), () => { throw original }), (error) => error === original)
        assert.equal(cancellations, 1)
        assert.equal(stream.locked, false)
        // Native node:test also treats a stray unhandled rejection as failure.
        await nextTurn()
    })
}

test('does not block error delivery on a pending source cancellation', async () => {
    const original = new Error('progress failed')
    const cleanup = new Error('late cleanup failure')
    /** @type {(reason: unknown) => void} */
    let rejectCancellation = () => {}
    const pendingCancellation = new Promise((_resolve, reject) => { rejectCancellation = reject })
    // The negative control may never call cancel; own this fixture promise too.
    void pendingCancellation.catch(() => {})
    let cancellations = 0
    const stream = new ReadableStream({
        start(controller) { controller.enqueue(Uint8Array.from([1])) },
        cancel() { ++cancellations; return pendingCancellation },
    })
    const read = RequestBuilder.readFetchResponseArrayBuffer(new Response(stream), () => { throw original })
    const outcome = await Promise.race([
        read.then(() => 'resolved', (error) => error),
        nextTurn().then(() => 'did not settle'),
    ])
    rejectCancellation(cleanup)
    await nextTurn()
    assert.equal(outcome, original)
    assert.equal(cancellations, 1)
    assert.equal(stream.locked, false)
})

test('releases the reader when the final progress notification throws', async () => {
    const {response, stream} = closedResponse([[1, 2]], '2')
    const original = new Error('completion observer failed')
    await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(response, (done) => {
        if (done) { throw original }
    }), (error) => error === original)
    assert.equal(stream.locked, false)
})

test('does not release or cancel a reader owned by another caller', async () => {
    const {response, stream} = closedResponse([[1, 2]], '2')
    const owner = stream.getReader()
    await assert.rejects(RequestBuilder.readFetchResponseArrayBuffer(response, () => {}), TypeError)
    assert.equal(stream.locked, true)
    assert.deepEqual((await owner.read()).value, Uint8Array.from([1, 2]))
    owner.releaseLock()
})

test('preserves the native no-progress response path', async () => {
    const {response} = closedResponse([[1, 2], [3]], '1')
    assert.deepEqual(await RequestBuilder.readFetchResponseArrayBuffer(response, null), Uint8Array.from([1, 2, 3]))
})

test('preserves the null-body completion path', async () => {
    /** @type {boolean[]} */
    const progress = []
    const bytes = await RequestBuilder.readFetchResponseArrayBuffer(new Response(null), (done) => { progress.push(done) })
    assert.deepEqual(bytes, new Uint8Array())
    assert.deepEqual(progress, [true])
})
