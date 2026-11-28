/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, describe, expect, test, vi} from 'vitest'
import {
    createImportIndexWorkerClient,
    ImportIndexWorkerClient,
    serializeImportIndexWorkerError,
} from '../ext/js/dictionary/term-record-import-index-worker-client.js'
import {createDeferredIndexChunkFixture} from './util/import-index-protocol-fixture.js'

/** @typedef {{id: number, writerId: number, action: string, chunks?: import('../ext/js/dictionary/term-record-import-index-chunk.js').ImportIndexChunk[]}} Request */
/** @typedef {{data?: unknown, message?: string}} PortEvent */

class Port {
    constructor() {
        /** @type {Map<string, ((event: PortEvent) => void)[]>} */
        this.listeners = new Map()
        /** @type {Request[]} */
        this.requests = []
        this.terminations = 0
    }

    /**
     * @param {string} type
     * @param {(event: PortEvent) => void} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
    }

    /**
     * @param {Request} request
     * @param {Transferable[]} transfer
     */
    postMessage(request, transfer) {
        // Exercise real structured-clone ownership, including sender detachment.
        this.requests.push(structuredClone(request, {transfer}))
    }

    terminate() { ++this.terminations }

    /**
     * @param {string} type
     * @param {PortEvent} event
     */
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) { listener(event) }
    }

    /**
     * @param {Request} request
     * @param {Record<string, unknown>} [value]
     */
    reply(request, value = {}) {
        this.emit('message', {data: {id: request.id, ...value}})
    }
}

/** @type {ImportIndexWorkerClient[]} */
const clients = []

/** @returns {{port: Port, client: ImportIndexWorkerClient}} */
function readyClient() {
    const port = new Port()
    const client = new ImportIndexWorkerClient(/** @type {Worker} */ (/** @type {unknown} */ (port)))
    clients.push(client)
    port.emit('message', {data: {type: 'ready'}})
    return {port, client}
}

/** @returns {Promise<{port: Port, client: ImportIndexWorkerClient, writer: NonNullable<Awaited<ReturnType<ImportIndexWorkerClient['open']>>>}>} */
async function openedWriter() {
    const {port, client} = readyClient()
    const opening = client.open(/** @type {FileSystemFileHandle} */ ({}))
    await Promise.resolve()
    expect(port.requests).toHaveLength(1)
    port.reply(port.requests[0], {result: 'opened'})
    const writer = await opening
    if (writer === null) { throw new Error('Expected worker writer') }
    return {port, client, writer}
}

afterEach(() => {
    for (const client of clients.splice(0)) { client.dispose() }
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

describe('import index worker client boundary', () => {
    test('falls back before readiness without sending a file handle', async () => {
        /** @type {Port[]} */
        const created = []
        class UnavailableWorker extends Port {
            constructor() {
                super()
                created.push(this)
                queueMicrotask(() => { this.emit('error', {message: 'Worker creation blocked'}) })
            }
        }
        vi.stubGlobal('Worker', UnavailableWorker)
        expect(await createImportIndexWorkerClient()).toBeNull()
        expect(created).toHaveLength(1)
        expect(created[0].requests).toHaveLength(0)
        expect(created[0].terminations).toBe(1)
    })

    test('accepts an explicit unsupported acquisition without mutating or replaying it', async () => {
        const {port, client} = readyClient()
        const opening = client.open(/** @type {FileSystemFileHandle} */ ({}))
        await Promise.resolve()
        port.reply(port.requests[0], {result: 'unsupported'})
        expect(await opening).toBeNull()
        expect(port.requests.map(({action}) => action)).toEqual(['open'])
        expect(port.terminations).toBe(0)
    })

    test('treats ambiguous acquisition loss as a terminal failure', async () => {
        const {port, client} = readyClient()
        const opening = client.open(/** @type {FileSystemFileHandle} */ ({}))
        const failed = opening.catch((error) => error)
        await Promise.resolve()
        port.emit('error', {message: 'Worker lost after acquisition request'})
        const failure = await failed
        expect(failure).toBeInstanceOf(Error)
        await expect(client.open(/** @type {FileSystemFileHandle} */ ({}))).rejects.toBe(failure)
        expect(port.requests.map(({action}) => action)).toEqual(['open'])
        expect(port.terminations).toBe(1)
    })

    test('transfers only complete private buffers and keeps generic writes owned by the caller', async () => {
        const {port, writer} = await openedWriter()
        const owner = Uint8Array.of(1, 2, 3, 4)
        const owned = Uint8Array.of(5, 6, 7)
        await expect(writer.writeOwnedChunks([owner.subarray(1)])).rejects.toBeInstanceOf(TypeError)
        await expect(writer.writeOwnedChunks([owner, owner])).rejects.toBeInstanceOf(TypeError)
        await expect(writer.writeOwnedChunks([new Uint8Array(new SharedArrayBuffer(4))])).rejects.toBeInstanceOf(TypeError)
        expect(owner.byteLength).toBe(4)
        expect(port.requests).toHaveLength(1)

        const ordinaryWrite = writer.write(owner)
        const ownedWrite = writer.writeOwnedChunks([owned])
        expect(owner.byteLength).toBe(4)
        expect(owned.byteLength).toBe(0)
        expect(port.requests[1].chunks).toEqual([Uint8Array.of(1, 2, 3, 4)])
        expect(port.requests[2].chunks).toEqual([Uint8Array.of(5, 6, 7)])
        port.reply(port.requests[1])
        port.reply(port.requests[2])
        await Promise.all([ordinaryWrite, ownedWrite])
        const closing = writer.close()
        port.reply(port.requests[3])
        await closing
    })

    test('returns one validated completed header per deferred envelope after moving every part once', async () => {
        const {port, writer} = await openedWriter()
        const first = createDeferredIndexChunkFixture(3)
        const second = createDeferredIndexChunkFixture(9)
        const eager = Uint8Array.of(8, 6, 4)
        const owned = [eager, first.chunk, second.chunk]
        const writing = writer.writeOwnedIndexChunks(owned)
        expect(eager.byteLength).toBe(0)
        for (const {chunk} of [first, second]) {
            expect([chunk.header.byteLength, chunk.payload.byteLength, chunk.recordFields.byteLength]).toEqual([0, 0, 0])
        }
        owned.length = 0
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeIndexChunks'])
        const headers = [null, first.expectedHeader, second.expectedHeader]
        port.reply(port.requests[1], {result: headers})
        expect(await writing).toEqual(headers)
        const closing = writer.close()
        port.reply(port.requests[2])
        await closing
    })

    test('retains the eager transfer operation and logical null receipts', async () => {
        const {port, writer} = await openedWriter()
        const chunks = [Uint8Array.of(1), Uint8Array.of(2)]
        const writing = writer.writeOwnedIndexChunks(chunks)
        chunks.length = 0
        expect(port.requests[1].action).toBe('writeChunks')
        port.reply(port.requests[1])
        expect(await writing).toEqual([null, null])
    })

    test.each(['partial view', 'aliased parts', 'shared part', 'short header', 'wrong length'])(
        'rejects an invalid deferred transfer before moving any part: %s',
        async (kind) => {
            const {port, writer} = await openedWriter()
            const {chunk} = createDeferredIndexChunkFixture()
            switch (kind) {
                case 'partial view': chunk.recordFields = chunk.recordFields.subarray(1); break
                case 'aliased parts': chunk.recordFields = chunk.payload; break
                case 'shared part': chunk.recordFields = new Uint8Array(new SharedArrayBuffer(12)); break
                case 'short header': chunk.header = new Uint8Array(39); break
            }
            chunk.byteLength = chunk.header.byteLength + chunk.payload.byteLength + chunk.recordFields.byteLength + (kind === 'wrong length' ? 1 : 0)
            const lengths = [chunk.header.byteLength, chunk.payload.byteLength, chunk.recordFields.byteLength]
            await expect(writer.writeOwnedIndexChunks([chunk])).rejects.toBeInstanceOf(TypeError)
            expect([chunk.header.byteLength, chunk.payload.byteLength, chunk.recordFields.byteLength]).toEqual(lengths)
            expect(port.requests.map(({action}) => action)).toEqual(['open'])
        },
    )

    test.each([
        'missing array',
        'wrong count',
        'non-null eager slot',
        'missing deferred slot',
        'wrong header type',
        'short header',
        'partial header view',
        'shared header',
        'changed first id',
        'changed length',
        'changed final byte',
    ])('makes a malformed header receipt sticky through close: %s', async (kind) => {
        const {port, writer} = await openedWriter()
        const first = createDeferredIndexChunkFixture(3)
        const second = createDeferredIndexChunkFixture(9)
        const writing = writer.writeOwnedIndexChunks([Uint8Array.of(1), first.chunk, second.chunk])
        const failed = writing.catch((error) => error)
        /** @type {unknown[]} */
        const headers = [null, first.expectedHeader, second.expectedHeader]
        switch (kind) {
            case 'wrong count': headers.pop(); break
            case 'non-null eager slot': headers[0] = new Uint8Array(40); break
            case 'missing deferred slot': headers[2] = null; break
            case 'wrong header type': headers[2] = new Uint32Array(10); break
            case 'short header': headers[2] = second.expectedHeader.slice(0, 39); break
            case 'partial header view': headers[2] = new Uint8Array(41).subarray(1); break
            case 'shared header': headers[2] = new Uint8Array(new SharedArrayBuffer(40)); break
            case 'changed first id': second.expectedHeader[0] ^= 1; break
            case 'changed length': second.expectedHeader[20] ^= 1; break
            case 'changed final byte': second.expectedHeader[39] ^= 1; break
        }
        const closing = writer.close()
        const closeFailure = closing.catch((error) => error)
        // Even an early close response cannot outrun validation of this receipt.
        port.reply(port.requests[2])
        port.reply(port.requests[1], {result: kind === 'missing array' ? void 0 : headers})
        const failure = await failed
        expect(failure).toBeInstanceOf(TypeError)
        expect(await closeFailure).toBe(failure)
        await expect(writer.writeOwnedIndexChunks([Uint8Array.of(2)])).rejects.toBe(failure)
        await expect(writer.close()).rejects.toBe(failure)
        await expect(writer.abort()).rejects.toBe(failure)
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeIndexChunks', 'close'])
    })

    test('preserves the first receipt failure when a later admitted write and close also fail', async () => {
        const {port, writer} = await openedWriter()
        const writing = writer.writeOwnedIndexChunks([createDeferredIndexChunkFixture().chunk])
        const firstFailure = writing.catch((error) => error)
        const later = writer.writeOwnedChunks([Uint8Array.of(1)]).catch((error) => error)
        const ids = new Map()
        port.reply(port.requests[1], {result: []})
        const original = await firstFailure
        port.reply(port.requests[2], {error: serializeImportIndexWorkerError(new Error('Later write witness'), ids)})
        expect(await later).toBe(original)
        const closing = writer.close().catch((error) => error)
        port.reply(port.requests[3], {error: serializeImportIndexWorkerError(new Error('Close witness'), ids)})
        const failure = await closing
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure.errors[0]).toBe(original)
        expect(failure.errors[1]).toMatchObject({message: 'Close witness'})
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeIndexChunks', 'writeChunks', 'close'])
    })

    test('sends abort after admitted writes without waiting for their acknowledgements', async () => {
        const {port, writer} = await openedWriter()
        const first = writer.writeOwnedChunks([Uint8Array.of(1)])
        const second = writer.writeOwnedChunks([Uint8Array.of(2)])
        const aborting = writer.abort()
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks', 'writeChunks', 'abort'])
        await expect(writer.write(Uint8Array.of(3))).rejects.toThrow('closed')
        port.reply(port.requests[1])
        port.reply(port.requests[2])
        port.reply(port.requests[3])
        await Promise.all([first, second, aborting])
        await writer.abort()
        await expect(writer.close()).rejects.toMatchObject({name: 'AbortError'})
        expect(port.requests).toHaveLength(4)
    })

    test('retains write error identity inside a later close aggregate', async () => {
        const {port, writer} = await openedWriter()
        const writeError = new Error('Disk write failed')
        const closeError = new Error('Disk close failed')
        const ids = new Map()
        const writing = writer.writeOwnedChunks([Uint8Array.of(1)])
        const writeFailure = writing.catch((error) => error)
        port.reply(port.requests[1], {error: serializeImportIndexWorkerError(writeError, ids)})
        const original = await writeFailure
        await expect(writer.write(Uint8Array.of(2))).rejects.toBe(original)
        const closing = writer.close()
        const closeFailure = closing.catch((error) => error)
        port.reply(port.requests[2], {error: serializeImportIndexWorkerError(new AggregateError([writeError, closeError], 'Finalization failed'), ids)})
        const failure = await closeFailure
        expect(failure).toBeInstanceOf(AggregateError)
        expect(failure.errors[0]).toBe(original)
        expect(failure.errors[1].message).toBe(closeError.message)
        await expect(writer.close()).rejects.toBe(failure)
        await expect(writer.abort()).rejects.toBe(failure)
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks', 'close'])
    })

    test('fails all admitted work on timeout without retransferring detached data', async () => {
        vi.useFakeTimers()
        const {port, writer} = await openedWriter()
        const bytes = Uint8Array.of(9, 8, 7)
        const writing = writer.writeOwnedChunks([bytes])
        const failed = writing.catch((error) => error)
        expect(bytes.byteLength).toBe(0)
        await vi.advanceTimersByTimeAsync(60_000)
        const failure = await failed
        expect(failure.message).toContain('timed out')
        await expect(writer.close()).rejects.toBe(failure)
        await expect(writer.write(Uint8Array.of(3))).rejects.toBe(failure)
        expect(port.terminations).toBe(1)
        expect(port.requests.map(({action}) => action)).toEqual(['open', 'writeChunks'])
    })

    test('rejects malformed error references instead of acknowledging a write', async () => {
        const {port, writer} = await openedWriter()
        const writing = writer.writeOwnedChunks([Uint8Array.of(1)])
        const failed = writing.catch((error) => error)
        port.reply(port.requests[1], {error: {id: 91}})
        const failure = await failed
        expect(failure).toBeInstanceOf(TypeError)
        await expect(writer.close()).rejects.toBe(failure)
        expect(port.terminations).toBe(1)
    })
})
