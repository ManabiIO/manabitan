/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Array<(event: MessageEvent<unknown>) => void>>} */
        this.listeners = new Map()
        /** @type {Array<{id: number, content: Uint8Array, dictName: string|null}>} */
        this.calls = []
        this.throwOnDispatch = false
        this.terminateCount = 0
    }

    /**
     * @param {string} type
     * @param {(event: MessageEvent<unknown>) => void} listener
     */
    addEventListener(type, listener) {
        const listeners = this.listeners.get(type) ?? []
        listeners.push(listener)
        this.listeners.set(type, listeners)
    }

    /**
     * @param {{id: number, content: Uint8Array, dictName: string|null}} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        if (this.throwOnDispatch) { throw new Error('dispatch failed') }
        expect(transfer).toEqual([message.content.buffer])
        this.calls.push(structuredClone(message, {transfer}))
        expect(message.content.byteLength).toBe(0)
    }

    /**
     * @param {number} call
     * @param {Record<string, unknown>} [response]
     */
    reply(call, response) {
        const message = this.calls[call]
        const result = response ?? {compressed: new Uint8Array(message.content).buffer, envelopeMs: 1}
        for (const listener of this.listeners.get('message') ?? []) {
            listener(/** @type {MessageEvent<unknown>} */ ({data: {id: message.id, ...result}}))
        }
    }

    terminate() { ++this.terminateCount }
}

/**
 * @param {ControlledWorker[]} workers
 * @returns {TermContentCompressionPool}
 */
function poolFor(workers) {
    return new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
}

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
}

describe('produced compression blocks', () => {
    test('packs one block per available worker and restores order after out-of-order completion', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()]
        const pool = poolFor(workers)
        const source = Uint8Array.of(10, 11, 12, 13, 14, 15)
        /** @type {number[]} */
        const produced = []
        const produce = (/** @type {number} */ index) => {
            produced.push(index)
            return source.slice(index, index + 1)
        }
        const pending = pool.compressWrappedProduced(source.length, produce, 'jmdict')
        try {
            expect(produced).toEqual([0, 1])
            expect(workers.map(({calls}) => calls.length)).toEqual([1, 1])
            workers[1].reply(0)
            await flush()
            expect(produced).toEqual([0, 1, 2])
            workers[1].reply(1)
            await flush()
            workers[0].reply(0)
            await flush()
            workers[1].reply(2)
            await flush()
            expect(produced).toHaveLength(6)
            workers[1].reply(3)
            workers[0].reply(1)
            const result = await pending
            expect(result.chunks.map((bytes) => bytes[0])).toEqual([...source])
            expect(result.envelopeMs).toBe(4)
            expect(result.wrapped).toBe(true)
            expect(source).toEqual(Uint8Array.of(10, 11, 12, 13, 14, 15))
            expect(workers.flatMap(({calls}) => calls).every(({dictName}) => dictName === 'jmdict')).toBe(true)
            expect(Reflect.get(pool, '_pending').size).toBe(0)
        } finally { pool.close() }
    })

    test.each(['producer', 'dispatch', 'worker', 'invalid-output'])(
        'stops admitting blocks after %s failure and drains other jobs before rejection',
        async (failure) => {
            const workers = [new ControlledWorker(), new ControlledWorker()]
            const pool = poolFor(workers)
            /** @type {number[]} */
            const produced = []
            const produce = (/** @type {number} */ index) => {
                produced.push(index)
                if (failure === 'producer' && index === 2) { throw new Error('producer failed') }
                return Uint8Array.of(index)
            }
            const pending = pool.compressWrappedProduced(7, produce, null)
            let settled = false
            void pending.finally(() => { settled = true }).catch(() => {})
            try {
                if (failure === 'dispatch') { workers[1].throwOnDispatch = true }
                if (failure === 'worker') {
                    workers[1].reply(0, {error: 'worker failed'})
                } else if (failure === 'invalid-output') {
                    workers[1].reply(0, {compressed: []})
                } else {
                    workers[1].reply(0)
                }
                await flush()
                const producedCount = produced.length
                expect(producedCount).toBe(failure === 'producer' || failure === 'dispatch' ? 3 : 2)
                expect(settled).toBe(false)
                expect(workers[0].calls).toHaveLength(1)
                workers[0].reply(0)
                await expect(pending).rejects.toThrow()
                expect(produced).toHaveLength(producedCount)
                expect(Reflect.get(pool, '_pending').size).toBe(0)
            } finally { pool.close() }
        },
    )

    test('preserves the first failure when another active block fails later', async () => {
        const workers = [new ControlledWorker(), new ControlledWorker()]
        const pool = poolFor(workers)
        const pending = pool.compressWrappedProduced(5, (index) => Uint8Array.of(index), null)
        void pending.catch(() => {})
        try {
            workers[1].reply(0, {error: 'first observed failure'})
            await flush()
            workers[0].reply(0, {error: 'later failure'})
            await expect(pending).rejects.toThrow('first observed failure')
        } finally { pool.close() }
    })

    test('pool closure drains a stalled worker without producing additional blocks', async () => {
        const worker = new ControlledWorker()
        const pool = poolFor([worker])
        /** @type {number[]} */
        const produced = []
        const produce = (/** @type {number} */ index) => {
            produced.push(index)
            return Uint8Array.of(index)
        }
        const pending = pool.compressWrappedProduced(5, produce, null)
        pool.close()
        await expect(pending).rejects.toThrow('closed')
        expect(produced).toHaveLength(1)
        expect(worker.terminateCount).toBe(1)
        expect(Reflect.get(pool, '_pending').size).toBe(0)
    })

    test.each(['partial', 'shared'])('rejects %s producer buffers without transferring them', async (kind) => {
        const worker = new ControlledWorker()
        const pool = poolFor([worker])
        const source = kind === 'partial' ? new Uint8Array(3).subarray(1) : new Uint8Array(new SharedArrayBuffer(2))
        try {
            await expect(pool.compressWrappedProduced(2, () => source, null)).rejects.toThrow('complete private buffer')
            expect(worker.calls).toHaveLength(0)
            expect(source.byteLength).toBe(2)
        } finally { pool.close() }
    })

    test.each([-1, 0.5, Number.NaN, Infinity])('rejects invalid block count %s before production', async (count) => {
        const pool = poolFor([new ControlledWorker()])
        const produce = vi.fn(() => Uint8Array.of(1))
        try {
            await expect(pool.compressWrappedProduced(count, produce, null)).rejects.toThrow('block count')
            expect(produce).not.toHaveBeenCalled()
        } finally { pool.close() }
    })

    test('keeps concurrent batches and their ordered results separate', async () => {
        const worker = new ControlledWorker()
        const pool = poolFor([worker])
        const first = pool.compressWrappedProduced(2, (index) => Uint8Array.of(index), null)
        const second = pool.compressWrappedProduced(2, (index) => Uint8Array.of(index + 10), null)
        try {
            expect(worker.calls.map(({content}) => content[0])).toEqual([0, 10])
            worker.reply(1)
            await flush()
            worker.reply(0)
            await flush()
            worker.reply(3)
            worker.reply(2)
            expect((await first).chunks.map((bytes) => bytes[0])).toEqual([0, 1])
            expect((await second).chunks.map((bytes) => bytes[0])).toEqual([10, 11])
        } finally { pool.close() }
    })
})
