/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterAll, beforeAll, beforeEach, describe, expect, test, vi} from 'vitest'

const state = vi.hoisted(() => ({
    /** @type {{key: number}|null} */
    active: null,
    /** @type {string[]} */
    events: [],
    failFinish: -1,
    initialization: Promise.resolve(),
}))

vi.mock('../ext/js/dictionary/zstd-term-content.js', () => {
    /**
     * @param {Uint8Array} source
     * @param {Uint32Array} offsets
     * @returns {{key: number}}
     */
    function prepare(source, offsets) {
        if (state.active !== null) { throw new Error('overlapping prepared buffers') }
        const prepared = {key: offsets[0]}
        state.active = prepared
        state.events.push(`prepare:${prepared.key}`)
        return prepared
    }
    /**
     * @param {{key: number}} prepared
     * @returns {{bytes: Uint8Array, envelopeMs: number}}
     */
    function finish(prepared) {
        if (state.active !== prepared) { throw new Error('prepared buffer replaced') }
        state.active = null
        state.events.push(`finish:${prepared.key}`)
        if (state.failFinish === prepared.key) { throw new Error('injected compression failure') }
        return {bytes: Uint8Array.of(prepared.key), envelopeMs: 0}
    }
    /**
     * @param {Uint8Array} content
     * @returns {Uint8Array}
     */
    function compress(content) { return new Uint8Array(content) }
    /**
     * @param {Uint8Array} content
     * @returns {{bytes: Uint8Array, envelopeMs: number}}
     */
    function compressWrapped(content) { return {bytes: compress(content), envelopeMs: 0} }
    return {
        initializeTermContentZstd: () => state.initialization,
        prepareWrappedTermContentZstdSpans: prepare,
        finishWrappedTermContentZstdSpans: finish,
        compressTermContentZstd: compress,
        compressWrappedTermContentZstd: compressWrapped,
    }
})

/** @type {((event: MessageEvent<unknown>) => void)|null} */
let receive = null
/** @type {Record<string, unknown>[]} */
const messages = []
const previousWorkerFlag = Reflect.get(globalThis, '__manabitanTermContentCompressionWorker')

/** @returns {Promise<void>} */
async function flush() {
    for (let i = 0; i < 20; ++i) { await Promise.resolve() }
}

/**
 * @param {Promise<void>} initialization
 * @returns {Promise<void>}
 */
async function loadWorker(initialization) {
    state.initialization = initialization
    vi.resetModules()
    receive = null
    const workerPath = '../ext/js/dictionary/zstd-term-content-compression-worker.js'
    // eslint-disable-next-line no-unsanitized/method -- Fixed local path; the worker entry has no static module declarations.
    await import(workerPath)
    await flush()
}

beforeAll(async () => {
    vi.stubGlobal('self', {
        /**
         * @param {string} type
         * @param {(event: MessageEvent<unknown>) => void} listener
         */
        addEventListener(type, listener) { if (type === 'message') { receive = listener } },
        /** @param {Record<string, unknown>} message */
        postMessage(message) { messages.push(structuredClone(message)) },
    })
    await loadWorker(Promise.resolve())
    expect(messages).toContainEqual({type: 'ready'})
})

beforeEach(async () => {
    messages.length = 0
    state.active = null
    state.events.length = 0
    state.failFinish = -1
    await loadWorker(Promise.resolve())
    messages.length = 0
})

afterAll(() => {
    vi.unstubAllGlobals()
    if (typeof previousWorkerFlag === 'undefined') {
        Reflect.deleteProperty(globalThis, '__manabitanTermContentCompressionWorker')
    } else {
        Reflect.set(globalThis, '__manabitanTermContentCompressionWorker', previousWorkerFlag)
    }
})

/**
 * @param {number} id
 * @returns {Record<string, unknown>}
 */
function job(id) {
    return {
        id,
        source: new Uint8Array(new SharedArrayBuffer(32)),
        sourceOffsets: Uint32Array.of(id),
        sourceLengths: Uint32Array.of(1),
        contentBytes: 1,
        dictName: 'jmdict',
        wrap: true,
    }
}

/** @param {unknown} data */
function send(data) {
    if (receive === null) { throw new Error('Worker message listener is missing') }
    receive(/** @type {MessageEvent<unknown>} */ ({data}))
}

describe('compression worker batch protocol', () => {
    test('pending initialization preserves worker order without reading any source early', async () => {
        /** @type {() => void} */
        let resolveInitialization = () => {}
        /** @type {Promise<void>} */
        const initialization = new Promise((resolve) => { resolveInitialization = resolve })
        await loadWorker(initialization)
        send({jobs: [job(1), job(4), job(7)]})
        await flush()
        expect(state.events).toEqual([])
        expect(messages).toEqual([])
        resolveInitialization()
        await flush()
        expect(state.events).toEqual(['prepare:1', 'finish:1', 'prepare:4', 'finish:4', 'prepare:7', 'finish:7'])
        expect(messages.filter(({compressed}) => compressed instanceof ArrayBuffer).map(({id}) => id)).toEqual([1, 4, 7])
    })

    test('rejected initialization rejects every queued ID without reading source bytes', async () => {
        /** @type {(error: Error) => void} */
        let rejectInitialization = () => {}
        /** @type {Promise<void>} */
        const initialization = new Promise((resolve, reject) => { rejectInitialization = reject })
        await loadWorker(initialization)
        send({jobs: [job(1), job(4), job(7)]})
        rejectInitialization(new Error('injected initialization failure'))
        await flush()
        expect(state.events).toEqual([])
        expect(messages.filter(({id}) => typeof id === 'number')).toEqual([1, 4, 7].map((id) => ({id, error: 'Error: injected initialization failure'})))
        expect(messages.some(({type}) => type === 'source-consumed')).toBe(false)
    })

    test('keeps preparation, acknowledgment, compression and output ordered per block', async () => {
        send({jobs: [job(1), job(4), job(7)]})
        await flush()
        expect(state.events).toEqual(['prepare:1', 'finish:1', 'prepare:4', 'finish:4', 'prepare:7', 'finish:7'])
        expect(messages.map(({id, type}) => [id, type ?? 'result'])).toEqual([
            [1, 'source-consumed'], [1, 'result'], [4, 'source-consumed'], [4, 'result'], [7, 'source-consumed'], [7, 'result'],
        ])
        expect(messages.filter(({compressed}) => compressed instanceof ArrayBuffer).map(({compressed}) => [...new Uint8Array(/** @type {ArrayBuffer} */ (compressed))])).toEqual([[1], [4], [7]])
    })

    test('a malformed job rejects its own ID and does not discard later jobs', async () => {
        send({jobs: [job(1), {...job(2), sourceLengths: Uint32Array.of(1, 2)}, job(3)]})
        await flush()
        expect(messages.find(({id}) => id === 2)).toMatchObject({id: 2, error: expect.stringContaining('span input is invalid')})
        expect(state.events).toEqual(['prepare:1', 'finish:1', 'prepare:3', 'finish:3'])
        expect(messages.at(-1)).toMatchObject({id: 3, compressed: expect.any(ArrayBuffer)})
    })

    test('post-ack compression failure preserves the acknowledgment and later jobs', async () => {
        state.failFinish = 2
        send({jobs: [job(1), job(2), job(3)]})
        await flush()
        expect(messages.filter(({id}) => id === 2)).toEqual([
            {type: 'source-consumed', id: 2},
            {id: 2, error: 'Error: injected compression failure'},
        ])
        expect(messages.at(-1)).toMatchObject({id: 3, compressed: expect.any(ArrayBuffer)})
        expect(state.active).toBeNull()
    })

    test('legacy individual packed and span requests still use their original responses', async () => {
        send({id: 9, content: Uint8Array.of(91), dictName: null})
        send(job(10))
        await flush()
        expect(messages.map(({id, type}) => [id, type ?? 'result'])).toEqual([[9, 'result'], [10, 'source-consumed'], [10, 'result']])
    })
})
