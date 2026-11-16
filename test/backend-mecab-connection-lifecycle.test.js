/* Copyright (C) 2026 Manabitan authors; SPDX-License-Identifier: GPL-3.0-or-later */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, test, vi} from 'vitest'
import {Backend} from '../ext/js/background/backend.js'
import {Mecab} from '../ext/js/comm/mecab.js'

/** @type {Mecab[]} */
const clients = []
afterEach(() => {
    for (const client of clients.splice(0)) { client.disconnect() }
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

function nativeEvent() {
    /** @type {Set<(...args: any[]) => void>} */
    const listeners = new Set()
    return {
        addListener: (/** @type {(...args: any[]) => void} */ listener) => listeners.add(listener),
        removeListener: (/** @type {(...args: any[]) => void} */ listener) => listeners.delete(listener),
        /** @param {...any} args */
        emit: (...args) => { for (const listener of listeners) { listener(...args) } },
    }
}

function setup() {
    const onMessage = nativeEvent()
    const onDisconnect = nativeEvent()
    const port = {onMessage, onDisconnect, postMessage: vi.fn(), disconnect: vi.fn()}
    const connectNative = vi.fn(() => port)
    vi.stubGlobal('chrome', {
        runtime: {connectNative, lastError: null},
        permissions: {contains: (/** @type {unknown} */ _request, /** @type {(allowed: boolean) => void} */ done) => done(true)},
    })
    const mecab = new Mecab()
    mecab.setEnabled(true)
    clients.push(mecab)
    const backend = /** @type {Backend} */ (Object.assign(Object.create(Backend.prototype), {_mecab: mecab}))
    const testConnection = () => backend._onApiTestMecab(undefined, {})
    /** @param {number} [version] */
    const replyVersion = (version = 1) => {
        const call = port.postMessage.mock.calls.find(([message]) => message.action === 'get_version')
        if (typeof call === 'undefined') { throw new Error('Version handshake was not requested') }
        onMessage.emit({sequence: call[0].sequence, data: {version}})
    }
    return {mecab, port, connectNative, testConnection, replyVersion}
}

test('the settings connection test closes the idle native host it opened', async () => {
    const h = setup()
    const result = h.testConnection()
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledOnce())
    h.replyVersion()
    await expect(result).resolves.toBe(true)
    expect(h.mecab.isConnected()).toBe(false)
    expect(h.port.disconnect).toHaveBeenCalledOnce()
})

test('the settings connection test preserves a concurrent parse sharing its handshake', async () => {
    const h = setup()
    const result = h.testConnection()
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledOnce())
    const parse = h.mecab.parseText('猫')
    const parsed = expect(parse).resolves.toEqual([])
    void parsed.catch(() => {})
    h.replyVersion()
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledTimes(2))
    await expect(result).resolves.toBe(true)
    const request = h.port.postMessage.mock.calls[1][0]
    expect(request).toMatchObject({action: 'parse_text', params: {text: '猫'}})
    h.port.onMessage.emit({sequence: request.sequence, data: {}})
    await parsed
    expect(h.port.disconnect).not.toHaveBeenCalled()
})

test('a failed reconnect cannot report the version from an earlier native host', async () => {
    const h = setup()
    const first = h.mecab.getVersion()
    h.replyVersion()
    await expect(first).resolves.toBe(1)
    h.mecab.disconnect()
    h.port.postMessage.mockClear()

    const result = h.testConnection()
    const rejected = expect(result).rejects.toThrow()
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledOnce())
    h.port.onDisconnect.emit()
    await rejected
    expect(h.mecab.isConnected()).toBe(false)
})

test('a later connection test retries after synchronous native connection failure', async () => {
    const h = setup()
    h.connectNative.mockImplementationOnce(() => { throw new Error('Native permission is temporarily unavailable') })
    await expect(h.testConnection()).rejects.toThrow()
    const result = h.testConnection()
    const completed = expect(result).resolves.toBe(true)
    void completed.catch(() => {})
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledOnce())
    h.replyVersion()
    await completed
    expect(h.connectNative).toHaveBeenCalledTimes(2)
})

test('testing an existing idle connection does not disconnect its owner', async () => {
    const h = setup()
    const first = h.mecab.getVersion()
    h.replyVersion()
    await first
    await expect(h.testConnection()).resolves.toBe(true)
    expect(h.mecab.isConnected()).toBe(true)
    expect(h.port.disconnect).not.toHaveBeenCalled()
})

test('an unsupported native version retains an actionable failure', async () => {
    const h = setup()
    const result = h.testConnection()
    const rejected = expect(result).rejects.toThrow(/version.*(supported|supports)/i)
    await vi.waitFor(() => expect(h.port.postMessage).toHaveBeenCalledOnce())
    h.replyVersion(2)
    await rejected
    expect(h.mecab.isConnected()).toBe(false)
})
