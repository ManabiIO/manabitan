/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import {afterEach, expect, test, vi} from 'vitest'
import {copyTermBankSourceRange, createTermBankSourceLease} from '../ext/js/dictionary/term-bank-source-copy.js'

class CopyWorker extends EventTarget {
    constructor() {
        super()
        this.postMessage = vi.fn()
        this.terminate = vi.fn()
    }

    /** @param {Record<string, unknown>} data */
    reply(data) {
        this.dispatchEvent(new MessageEvent('message', {data}))
    }
}

afterEach(() => { vi.useRealTimers() })

test('copies exactly a nonzero leased range into independently owned bytes', () => {
    const memory = new WebAssembly.Memory({initial: 1, maximum: 2, shared: true})
    const source = new Uint8Array(memory.buffer, 19, 12)
    source.set([99, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 88])
    const owned = copyTermBankSourceRange(source, 2, 7)
    expect([...owned]).toEqual([2, 3, 4, 5, 6, 7, 8])
    expect(owned.buffer).toBeInstanceOf(ArrayBuffer)
    source.fill(77)
    memory.grow(1)
    expect([...owned]).toEqual([2, 3, 4, 5, 6, 7, 8])
    for (const [offset, length] of [[-1, 1], [0, 13], [13, 0], [0.5, 2], [0, Infinity]]) {
        expect(() => copyTermBankSourceRange(source, offset, length)).toThrow(RangeError)
    }
})

test('holds a released parser lease until the matching copy transfer arrives', async () => {
    const worker = new CopyWorker()
    const source = new Uint8Array(new SharedArrayBuffer(20), 3, 12)
    source.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    const failure = vi.fn()
    const lease = createTermBankSourceLease(/** @type {Worker} */ (/** @type {unknown} */ (worker)), 7, source, () => false, failure)
    const consumed = vi.fn()
    void lease.consumed.then(consumed)
    const copying = lease.copyRange(source.subarray(2, 10), 1, 5)
    expect(worker.postMessage).toHaveBeenCalledWith({type: 'copy-content-range', id: 7, requestId: 1, offset: 3, length: 4})
    lease.release()
    lease.release()
    worker.reply({type: 'content-copy-result', id: 8, requestId: 1, bytes: new ArrayBuffer(4)})
    worker.reply({type: 'content-copy-result', id: 7, requestId: 2, bytes: new ArrayBuffer(4)})
    await Promise.resolve()
    expect(consumed).not.toHaveBeenCalled()
    const owned = source.slice(3, 7)
    worker.reply({type: 'content-copy-result', id: 7, requestId: 1, bytes: owned.buffer})
    await expect(copying).resolves.toEqual(owned)
    await lease.consumed
    expect(consumed).toHaveBeenCalledOnce()
    expect(failure).not.toHaveBeenCalled()
    expect(lease.copyRange(source, 0, 1)).toBeNull()
})

test('declines unrelated or nonshared buffers without dispatching', async () => {
    const worker = new CopyWorker()
    const source = new Uint8Array(new SharedArrayBuffer(12), 2, 8)
    const lease = createTermBankSourceLease(/** @type {Worker} */ (/** @type {unknown} */ (worker)), 1, source, () => false, vi.fn())
    expect(lease.copyRange(new Uint8Array(8), 0, 1)).toBeNull()
    expect(lease.copyRange(new Uint8Array(source.buffer), 0, 1)).toBeNull()
    expect(worker.postMessage).not.toHaveBeenCalled()
    lease.release()
    await lease.consumed
})

test.each(['error', 'messageerror', 'invalid-result', 'dispatch', 'timeout', 'cancel'])('settles copy and lease after %s failure', async (kind) => {
    vi.useFakeTimers()
    const worker = new CopyWorker()
    const removeListener = vi.spyOn(worker, 'removeEventListener')
    const source = new Uint8Array(new SharedArrayBuffer(8))
    const failure = vi.fn()
    if (kind === 'dispatch') {
        worker.postMessage.mockImplementation(() => { throw new Error('dispatch failed') })
    }
    const lease = createTermBankSourceLease(/** @type {Worker} */ (/** @type {unknown} */ (worker)), 1, source, () => kind === 'cancel', failure)
    const copying = lease.copyRange(source, 0, 4)
    const observed = Promise.resolve(copying).then(() => null, (error) => error)
    lease.release()
    if (kind === 'error') { worker.dispatchEvent(new Event('error')) }
    if (kind === 'messageerror') { worker.dispatchEvent(new Event('messageerror')) }
    if (kind === 'invalid-result') { worker.reply({type: 'content-copy-result', id: 1, requestId: 1, bytes: new SharedArrayBuffer(4)}) }
    if (kind === 'timeout') { await vi.advanceTimersByTimeAsync(300_000) }
    if (kind === 'cancel') { await vi.advanceTimersByTimeAsync(25) }
    expect(await observed).toBeInstanceOf(Error)
    await lease.consumed
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(failure).toHaveBeenCalledOnce()
    expect(removeListener.mock.calls.map(([type]) => type).sort()).toEqual(['error', 'message', 'messageerror'])
    expect(vi.getTimerCount()).toBe(0)
})


test.each(['registration', 'removal', 'termination', 'notification'])('settles the lease even when %s throws', async (kind) => {
    vi.useFakeTimers()
    const worker = new CopyWorker()
    const source = new Uint8Array(new SharedArrayBuffer(8))
    const failure = vi.fn()
    if (kind === 'registration') {
        vi.spyOn(worker, 'addEventListener').mockImplementationOnce(() => { throw new Error('registration failure') })
    }
    if (kind === 'removal') {
        vi.spyOn(worker, 'removeEventListener').mockImplementationOnce(() => { throw new Error('removal failure') })
    }
    if (kind === 'termination') {
        worker.terminate.mockImplementationOnce(() => { throw new Error('termination failure') })
    }
    if (kind === 'notification') {
        failure.mockImplementationOnce(() => { throw new Error('notification failure') })
    }
    const lease = createTermBankSourceLease(/** @type {Worker} */ (/** @type {unknown} */ (worker)), 1, source, () => false, failure)
    const copying = lease.copyRange(source, 0, 4)
    const observed = Promise.resolve(copying).then(() => null, (error) => error)
    lease.release()
    if (kind !== 'registration') { worker.dispatchEvent(new Event('messageerror')) }
    expect(await observed).toBeInstanceOf(Error)
    await lease.consumed
    expect(failure).toHaveBeenCalledOnce()
    expect(worker.terminate).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
})
