/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest'

const codec = vi.hoisted(() => ({initialize: vi.fn(), prepare: vi.fn(), finish: vi.fn(), compress: vi.fn(), compressWrapped: vi.fn()}))
vi.mock('../ext/js/dictionary/zstd-term-content.js', () => ({
    initializeTermContentZstd: codec.initialize,
    prepareWrappedTermContentZstdSpans: codec.prepare,
    finishWrappedTermContentZstdSpans: codec.finish,
    compressTermContentZstd: codec.compress,
    compressWrappedTermContentZstd: codec.compressWrapped,
}))

beforeEach(() => {
    vi.resetModules()
    vi.resetAllMocks()
})
afterEach(() => { vi.unstubAllGlobals() })

/**
 * Exercises the production worker handler with a synchronous codec and browser
 * transport faults. The separate native-context suite checks actual frames.
 * @param {'none'|'prepare'|'finish'|'ack-post'|'result-post'} [failure]
 */
async function loadWorker(failure = 'none') {
    const events = /** @type {string[]} */ ([])
    const messages = /** @type {Record<string, unknown>[]} */ ([])
    let listener = /** @type {((event: MessageEvent) => void)|null} */ (null)
    let initialize = () => {}
    codec.initialize.mockReturnValue(new Promise((resolve) => { initialize = () => { resolve(undefined) } }))
    codec.prepare.mockImplementation((
        /** @type {Uint8Array} */ source,
        /** @type {Uint32Array} */ offsets,
        /** @type {Uint32Array} */ lengths,
        /** @type {number} */ contentBytes,
    ) => {
        events.push(`prepare:${source[0]}`)
        if (failure === 'prepare') { throw new Error('injected prepare failure') }
        const bytes = new Uint8Array(contentBytes)
        let cursor = 0
        for (let i = 0; i < offsets.length; ++i) {
            bytes.set(source.subarray(offsets[i], offsets[i] + lengths[i]), cursor)
            cursor += lengths[i]
        }
        return {bytes}
    })
    codec.finish.mockImplementation((/** @type {{bytes: Uint8Array}} */ prepared) => {
        events.push(`finish:${prepared.bytes[0]}`)
        if (failure === 'finish') { throw new Error('injected finish failure') }
        return {bytes: prepared.bytes, envelopeMs: 0}
    })
    vi.stubGlobal('__manabitanTermContentCompressionWorker', false)
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {(event: MessageEvent) => void} value
         */
        addEventListener(type, value) {
            if (type === 'message') { listener = value }
        },
        /**
         * @param {Record<string, unknown>} message
         * @param {Transferable[]} [transfer]
         */
        postMessage(message, transfer = []) {
            if (failure === 'ack-post' && message.type === 'source-consumed') {
                throw new Error('injected acknowledgment post failure')
            }
            if (failure === 'result-post' && message.compressed instanceof ArrayBuffer) {
                throw new Error('injected result post failure')
            }
            messages.push(structuredClone(message, {transfer}))
            if (message.type !== 'ready') {
                events.push(`${message.type ?? (message.error ? 'error' : 'result')}:${message.id}`)
            }
        },
    })
    await import('../ext/js/dictionary/zstd-term-content-compression-worker.js')
    /**
     * @param {number} id
     * @param {boolean} [acknowledgeSourceConsumed]
     */
    const send = (id, acknowledgeSourceConsumed) => {
        if (listener === null) { throw new Error('Worker listener is missing') }
        const source = new Uint8Array(new SharedArrayBuffer(4)).fill(id)
        listener(/** @type {MessageEvent} */ ({data: {
            id, source, sourceOffsets: Uint32Array.of(0), sourceLengths: Uint32Array.of(4),
            contentBytes: 4, dictName: 'jmdict', wrap: true,
            ...(typeof acknowledgeSourceConsumed === 'undefined' ? {} : {acknowledgeSourceConsumed}),
        }}))
    }
    /** @param {number} count */
    const waitForResults = async (count) => {
        await vi.waitFor(() => {
            expect(messages.filter(({compressed, error}) => compressed instanceof ArrayBuffer || typeof error === 'string')).toHaveLength(count)
        })
    }
    return {initialize, send, waitForResults, messages, events}
}

describe('compression worker source acknowledgment protocol', () => {
    test('preserves queued job order across initialization and omits only requested acknowledgments', async () => {
        const worker = await loadWorker()
        worker.send(1, false)
        worker.send(2, true)
        worker.send(3)
        expect(worker.events).toEqual([])
        worker.initialize()
        await worker.waitForResults(3)
        expect(worker.events).toEqual([
            'prepare:1', 'finish:1', 'result:1',
            'prepare:2', 'source-consumed:2', 'finish:2', 'result:2',
            'prepare:3', 'source-consumed:3', 'finish:3', 'result:3',
        ])
        for (const id of [1, 2, 3]) {
            const result = worker.messages.find((message) => message.id === id && message.compressed instanceof ArrayBuffer)
            expect(new Uint8Array(/** @type {ArrayBuffer} */ (result?.compressed))).toEqual(new Uint8Array(4).fill(id))
        }
    })

    test.each(['prepare', 'finish', 'ack-post', 'result-post'])(
        'retains exact source-consumption state after %s failure',
        async (failure) => {
            const worker = await loadWorker(/** @type {'prepare'|'finish'|'ack-post'|'result-post'} */ (failure))
            worker.send(1, true)
            worker.initialize()
            await worker.waitForResults(1)
            const response = worker.messages.find(({id, error}) => id === 1 && typeof error === 'string')
            expect(response?.error).toContain(`injected ${failure === 'ack-post' ? 'acknowledgment post' : failure.replace('-', ' ')} failure`)
            expect(response?.sourceConsumed === true).toBe(failure === 'finish' || failure === 'result-post')
            expect(worker.messages.some(({type}) => type === 'source-consumed')).toBe(failure === 'finish' || failure === 'result-post')
            if (failure === 'ack-post') { expect(codec.finish).not.toHaveBeenCalled() }
        },
    )

    test.each(['finish', 'result-post'])('carries suppressed consumption through a terminal %s failure', async (failure) => {
        const worker = await loadWorker(/** @type {'finish'|'result-post'} */ (failure))
        worker.send(1, false)
        worker.initialize()
        await worker.waitForResults(1)
        expect(worker.messages.some(({type}) => type === 'source-consumed')).toBe(false)
        expect(worker.messages.find(({id, error}) => id === 1 && typeof error === 'string')).toMatchObject({
            sourceConsumed: true,
            error: expect.stringContaining(`injected ${failure.replace('-', ' ')} failure`),
        })
    })

    test('does not acknowledge a suppressed source when preparation fails', async () => {
        const worker = await loadWorker('prepare')
        worker.send(1, false)
        worker.initialize()
        await worker.waitForResults(1)
        expect(worker.messages.some(({type}) => type === 'source-consumed')).toBe(false)
        const response = worker.messages.find(({id, error}) => id === 1 && typeof error === 'string')
        expect(response?.error).toContain('injected prepare failure')
        expect(response).not.toHaveProperty('sourceConsumed')
    })
})
