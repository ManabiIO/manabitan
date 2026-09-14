/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, describe, expect, test, vi} from 'vitest'

vi.mock('../ext/js/core/diagnostics-reporter.js', () => ({
    isDevDiagnosticsBuild: false,
    reportDiagnostics: vi.fn(),
    reportDiagnosticsLazy: vi.fn(),
}))

const {Backend} = await import('../ext/js/background/backend.js')
const {OffscreenProxy} = await import('../ext/js/background/offscreen-proxy.js')

/** @returns {{promise: Promise<void>, resolve: () => void, reject: (error: Error) => void}} */
function deferred() {
    /** @type {() => void} */
    let resolve = () => {}
    /** @type {(error: Error) => void} */
    let reject = () => {}
    const promise = /** @type {Promise<void>} */ (new Promise((resolvePromise, rejectPromise) => {
        resolve = () => { resolvePromise(undefined) }
        reject = rejectPromise
    }))
    return {promise, resolve, reject}
}

function createPort() {
    return /** @type {MessagePort} */ (/** @type {unknown} */ ({
        postMessage: vi.fn(),
        close: vi.fn(),
        onmessageerror: null,
    }))
}

function createProxy() {
    const port = createPort()
    const getContexts = vi.fn().mockResolvedValue([{}])
    const createDocument = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('chrome', {
        runtime: {lastError: undefined, getURL: () => 'chrome-extension://test/offscreen.html', getContexts},
        offscreen: {createDocument},
    })
    const messenger = {sendMessagePromise: vi.fn(async () => {
        await proxy.registerOffscreenPort(port)
        return {result: undefined}
    })}
    const proxy = new OffscreenProxy(/** @type {import('../ext/js/extension/web-extension.js').WebExtension} */ (/** @type {unknown} */ (messenger)))
    return {proxy, port, messenger, getContexts, createDocument}
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

describe('runtime reliability lifecycle boundaries', () => {
    test('publishes the mutation queue before invoking a synchronously reentrant task', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype))
        Reflect.set(backend, '_dictionaryMutationPromise', null)
        const gate = deferred()
        const started = deferred()
        /** @type {string[]} */
        const events = []
        /** @type {Promise<void>|undefined} */
        let nested
        const first = backend._runDictionaryMutation(async () => {
            events.push('first-start')
            // Enqueue without awaiting a child from its own serialized parent.
            nested = backend._runDictionaryMutation(async () => { events.push('nested') })
            started.resolve()
            await gate.promise
            events.push('first-end')
        })
        try {
            await started.promise
            expect(events).toEqual(['first-start'])
        } finally {
            gate.resolve()
            await first
            await nested
        }
        expect(events).toEqual(['first-start', 'first-end', 'nested'])
        expect(Reflect.get(backend, '_dictionaryMutationPromise')).toBeNull()
    })

    test('a rejected mutation neither poisons nor prematurely clears its queued successor', async () => {
        const backend = /** @type {Backend} */ (Object.create(Backend.prototype))
        Reflect.set(backend, '_dictionaryMutationPromise', null)
        const firstGate = deferred()
        const secondGate = deferred()
        const secondStarted = deferred()
        const first = backend._runDictionaryMutation(() => firstGate.promise)
        const rejected = expect(first).rejects.toThrow('first failed')
        const second = backend._runDictionaryMutation(async () => {
            secondStarted.resolve()
            await secondGate.promise
        })
        const tail = Reflect.get(backend, '_dictionaryMutationPromise')
        try {
            firstGate.reject(new Error('first failed'))
            await rejected
            await secondStarted.promise
            expect(Reflect.get(backend, '_dictionaryMutationPromise')).toBe(tail)
        } finally {
            secondGate.resolve()
            await second
        }
        expect(Reflect.get(backend, '_dictionaryMutationPromise')).toBeNull()
    })

    test('shares document existence checking as well as creation across concurrent recovery', async () => {
        const {proxy, messenger, getContexts, createDocument} = createProxy()
        const probeGate = deferred()
        getContexts.mockImplementation(async () => {
            await probeGate.promise
            return []
        })
        messenger.sendMessagePromise.mockResolvedValue({result: undefined})
        const first = proxy.sendMessagePromise({action: 'getDictionaryInfoOffscreen', params: undefined})
        const second = proxy.sendMessagePromise({action: 'getDictionaryInfoOffscreen', params: undefined})
        try {
            expect(getContexts).toHaveBeenCalledTimes(1)
        } finally {
            probeGate.resolve()
            await Promise.all([first, second])
        }
        expect(createDocument).toHaveBeenCalledTimes(1)
    })

    test('invalidates the old control port when an ordinary message recreates the document', async () => {
        const {proxy, messenger, getContexts, createDocument} = createProxy()
        const oldPort = createPort()
        await proxy.registerOffscreenPort(oldPort)
        getContexts.mockResolvedValue([])
        messenger.sendMessagePromise.mockResolvedValue({result: undefined})
        await proxy.sendMessagePromise({action: 'getDictionaryInfoOffscreen', params: undefined})
        expect(createDocument).toHaveBeenCalledOnce()
        expect(oldPort.close).toHaveBeenCalledOnce()
        expect(Reflect.get(proxy, '_currentOffscreenPort')).toBeNull()
    })

    test('rebuilds a silently stale transfer port after the offscreen document disappears', async () => {
        const {proxy, port, getContexts, createDocument} = createProxy()
        const oldPort = createPort()
        await proxy.registerOffscreenPort(oldPort)
        getContexts.mockResolvedValue([])
        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])
        expect(createDocument).toHaveBeenCalledOnce()
        expect(oldPort.close).toHaveBeenCalledOnce()
        expect(oldPort.postMessage).not.toHaveBeenCalled()
        expect(port.postMessage).toHaveBeenCalledOnce()
    })

    test('clears the registration deadline after successful bootstrap', async () => {
        vi.useFakeTimers()
        const {proxy, port} = createProxy()
        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])
        expect(port.postMessage).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    test('a missing registration times out and a subsequent bootstrap succeeds', async () => {
        vi.useFakeTimers()
        const {proxy, messenger, port} = createProxy()
        messenger.sendMessagePromise.mockResolvedValueOnce({result: undefined})
        const failed = expect(proxy.prepare()).rejects.toThrow('Timed out waiting for offscreen control port registration')
        await vi.advanceTimersByTimeAsync(5000)
        await failed
        expect(Reflect.get(proxy, '_registeringOffscreenPort')).toBeNull()
        await proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])
        expect(port.postMessage).toHaveBeenCalledOnce()
        expect(vi.getTimerCount()).toBe(0)
    })

    test('concurrent transfer requests share a single registration', async () => {
        const {proxy, messenger, port} = createProxy()
        const gate = deferred()
        messenger.sendMessagePromise.mockImplementation(async () => {
            await gate.promise
            await proxy.registerOffscreenPort(port)
            return {result: undefined}
        })
        const first = proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])
        const second = proxy.sendMessageViaPort({action: 'connectToDatabaseWorker'}, [])
        gate.resolve()
        await Promise.all([first, second])
        expect(messenger.sendMessagePromise).toHaveBeenCalledOnce()
        expect(port.postMessage).toHaveBeenCalledTimes(2)
    })

    test('failed document creation can be retried without retaining a poisoned flight', async () => {
        const {proxy, getContexts, createDocument} = createProxy()
        getContexts.mockResolvedValue([])
        createDocument.mockRejectedValueOnce(new Error('creation failed'))
        await expect(proxy.prepare()).rejects.toThrow('creation failed')
        expect(Reflect.get(proxy, '_creatingOffscreen')).toBeNull()
        expect(Reflect.get(proxy, '_registeringOffscreenPort')).toBeNull()
        await expect(proxy.prepare()).resolves.toBeUndefined()
        expect(createDocument).toHaveBeenCalledTimes(2)
    })

    test('an error from a retired control port cannot clear its replacement', async () => {
        const {proxy, port} = createProxy()
        const oldPort = createPort()
        await proxy.registerOffscreenPort(oldPort)
        const onOldError = oldPort.onmessageerror
        await proxy.registerOffscreenPort(port)
        onOldError?.call(oldPort, new MessageEvent('messageerror'))
        expect(Reflect.get(proxy, '_currentOffscreenPort')).toBe(port)
        expect(port.close).not.toHaveBeenCalled()
    })
})
