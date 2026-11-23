/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFile} from 'node:fs/promises'
import {Worker as NodeWorker} from 'node:worker_threads'
import {afterEach, describe, expect, test, vi} from 'vitest'
import {TermContentCompressionPool} from '../ext/js/dictionary/zstd-term-content.js'

class ControlledWorker {
    constructor() {
        /** @type {Map<string, Set<(event: import('core').SafeAny) => void>>} */
        this.listeners = new Map()
        /** @type {Record<string, unknown>[]} */
        this.calls = []
        this.terminateCount = 0
        this.throwOnDispatch = false
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    addEventListener(type, listener) {
        this.listeners.set(type, (this.listeners.get(type) ?? new Set()).add(listener))
    }

    /**
     * @param {string} type
     * @param {(event: import('core').SafeAny) => void} listener
     */
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener) }

    /**
     * @param {string} type
     * @param {unknown} event
     */
    emit(type, event) {
        for (const listener of this.listeners.get(type) ?? []) { listener(event) }
    }

    /**
     * @param {Record<string, unknown>} message
     * @param {Transferable[]} transfer
     */
    postMessage(message, transfer) {
        if (this.throwOnDispatch) { throw new Error('injected dispatch failure') }
        this.calls.push(structuredClone(message, {transfer}))
    }

    /**
     * @param {number} index
     * @param {Record<string, unknown>} [response]
     */
    reply(index, response = {}) {
        const call = this.calls[index]
        const content = /** @type {Uint8Array} */ (call.content)
        this.emit('message', {data: {id: call.id, compressed: Uint8Array.from(content).buffer, envelopeMs: 1, ...response}})
    }

    terminate() { ++this.terminateCount }
}

/**
 * @param {ControlledWorker[]} workers
 * @returns {TermContentCompressionPool}
 */
function createPool(workers) {
    return new TermContentCompressionPool(/** @type {Worker[]} */ (/** @type {unknown} */ (workers)))
}

/** @returns {Promise<void>} */
async function flush() {
    await new Promise((resolve) => { setTimeout(resolve, 0) })
}

afterEach(() => { vi.unstubAllGlobals() })

/** @returns {Promise<typeof import('../ext/js/dictionary/zstd-term-content.js')>} */
async function loadCodec() {
    vi.stubGlobal('fetch', async (/** @type {RequestInfo|URL} */ input) => {
        const resource = new URL(String(input))
        if (resource.protocol !== 'file:') { throw new Error('Unexpected codec resource') }
        return new Response(await readFile(resource), {headers: {'Content-Type': 'application/wasm'}})
    })
    const api = await import('../ext/js/dictionary/zstd-term-content.js')
    await api.initializeTermContentZstd()
    return api
}

describe('packed source snapshot boundary', () => {
    test.each([[false, false], [true, false], [false, true], [true, true]])('snapshots source with workers ready=%s and detach=%s', async (ready, detach) => {
        vi.resetModules()
        /** @type {ControlledWorker[]} */
        const workers = []
        class CodecWorker extends ControlledWorker {
            constructor() { super(); workers.push(this) }
            /**
             * @param {Record<string, unknown>} message
             * @param {Transferable[]} transfer
             */
            postMessage(message, transfer) {
                super.postMessage(message, transfer)
                const data = this.calls[this.calls.length - 1]
                const result = api.compressWrappedTermContentZstd(/** @type {Uint8Array} */ (data.content), 'jmdict')
                queueMicrotask(() => this.emit('message', {data: {id: data.id, compressed: result.bytes.buffer}}))
            }
        }
        vi.stubGlobal('Worker', CodecWorker)
        const api = await loadCodec()
        try {
            expect(workers).toHaveLength(4)
            if (ready) {
                for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
                await flush()
            }
            const {TermContentOpfsStore} = await import('../ext/js/dictionary/term-content-opfs-store.js')
            const {TermContentBlockStore} = await import('../ext/js/dictionary/term-content-block-store.js')
            const blockStore = new TermContentBlockStore(new TermContentOpfsStore(), {blockTargetBytes: 4, minInputBytes: 0})
            const source = Uint8Array.of(91, 2, 3, 4, 5, 6, 7, 8, 92)
            const offsets = Uint32Array.of(1, 5, 2)
            const lengths = Uint32Array.of(4, 3, 2)
            const expected = Array.from(offsets, (offset, index) => source.slice(offset, offset + lengths[index]))
            await expect(blockStore.tryAppendSpans(source, Uint32Array.of(1, 5, 8), lengths, 'jmdict', true)).rejects.toThrow('out of bounds')
            expect(workers.every(({calls}) => calls.length === 0)).toBe(true)
            const pending = blockStore.tryAppendSpans(source, offsets, lengths, 'jmdict', true)
            source.fill(0)
            if (detach) { structuredClone(source, {transfer: [source.buffer]}) }
            if (!ready) {
                expect(workers.every(({calls}) => calls.length === 0)).toBe(true)
                for (const worker of workers) { worker.emit('message', {data: {type: 'ready'}}) }
            }
            const result = await pending
            if (result === null) { throw new Error('Expected block storage') }
            for (let index = 0; index < expected.length; ++index) {
                expect(await blockStore.read(result.contentOffsets[index], lengths[index], result.contentDictName)).toEqual(expected[index])
            }
            expect(workers.reduce((count, worker) => count + worker.calls.length, 0)).toBe(3)
        } finally {
            for (const worker of workers) { worker.emit('error', {message: 'test cleanup'}) }
        }
    })
})

