/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */
import assert from 'node:assert/strict'
import {afterEach, beforeEach, test} from 'vitest'
import {ClipboardMonitor} from '../ext/js/comm/clipboard-monitor.js'

const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout
/** @type {Map<number, () => Promise<void>>} */
let timers
let nextId = 0

beforeEach(() => {
    timers = new Map()
    nextId = 0
    /**
     * @param {() => Promise<void>} callback
     * @returns {number}
     */
    const schedule = (callback) => {
        const id = ++nextId
        timers.set(id, callback)
        return id
    }
    globalThis.setTimeout = /** @type {typeof setTimeout} */ (/** @type {unknown} */ (schedule))
    globalThis.clearTimeout = (id) => { timers.delete(Number(id)) }
})

afterEach(() => {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
})

/** @returns {Promise<void>} */
async function tick() {
    const entry = timers.entries().next().value
    assert.ok(entry)
    timers.delete(entry[0])
    await entry[1]()
}

/** @returns {{promise: Promise<string>, resolve: (value: string) => void}} */
function deferredText() {
    /** @type {(value: string) => void} */
    let resolve = () => { throw new Error('Uninitialized deferred') }
    /** @type {Promise<string>} */
    const promise = new Promise((resolve2) => { resolve = resolve2 })
    return {promise, resolve}
}

test('stop inside a change listener cannot schedule another poll', async () => {
    let reads = 0
    const monitor = new ClipboardMonitor({getText: async () => `${++reads}`})
    monitor.on('change', () => monitor.stop())
    monitor.start()
    await Promise.resolve()
    await tick()
    assert.equal(reads, 2)
    assert.equal(timers.size, 0)
    assert.equal(monitor._timerId, null)
})

test('no clipboard read occurs after a change listener disables monitoring', async () => {
    let reads = 0
    const monitor = new ClipboardMonitor({getText: async () => `${++reads}`})
    monitor.on('change', () => monitor.stop())
    monitor.start()
    await Promise.resolve()
    await tick()
    for (const callback of timers.values()) { await callback() }
    assert.equal(reads, 2)
})

test('restart inside a change listener leaves only the new generation scheduled', async () => {
    let reads = 0
    const monitor = new ClipboardMonitor({getText: async () => `${++reads}`})
    monitor.on('change', () => monitor.start())
    monitor.start()
    await Promise.resolve()
    await tick()
    assert.equal(reads, 3)
    assert.equal(timers.size, 1)
    monitor.stop()
    assert.equal(timers.size, 0)
})

test('a stale timer cannot read or discard the current generation timer handle', async () => {
    let reads = 0
    const monitor = new ClipboardMonitor({getText: async () => `${++reads}`})
    monitor.start()
    await Promise.resolve()
    const oldCallback = timers.values().next().value
    assert.ok(oldCallback)
    monitor.start()
    await Promise.resolve()
    const currentTimer = monitor._timerId
    await oldCallback()
    assert.equal(reads, 2)
    assert.equal(monitor._timerId, currentTimer)
    monitor.stop()
    assert.equal(timers.size, 0)
})

test('an in-flight read completing after stop cannot notify or reschedule', async () => {
    const pending = deferredText()
    const monitor = new ClipboardMonitor({getText: () => pending.promise})
    /** @type {string[]} */
    const changes = []
    monitor.on('change', ({text}) => changes.push(text))
    monitor.start()
    monitor.stop()
    pending.resolve('old')
    await Promise.resolve()
    assert.deepEqual(changes, [])
    assert.equal(timers.size, 0)
    assert.equal(monitor._previousText, null)
})

test('an old read completing after restart cannot replace the new baseline', async () => {
    const pending = deferredText()
    let reads = 0
    const monitor = new ClipboardMonitor({getText: () => (++reads === 1 ? pending.promise : Promise.resolve('new'))})
    monitor.start()
    monitor.start()
    await Promise.resolve()
    const currentTimer = monitor._timerId
    pending.resolve('old')
    await Promise.resolve()
    assert.equal(monitor._previousText, 'new')
    assert.equal(monitor._timerId, currentTimer)
    assert.equal(timers.size, 1)
    monitor.stop()
})

test('ordinary polling still trims text, ignores initial content, blanks and duplicates', async () => {
    const values = [' first ', 'first', '  ', ' second ', 'second']
    const monitor = new ClipboardMonitor({getText: async (rich) => {
        assert.equal(rich, false)
        return values.shift() ?? ''
    }})
    /** @type {string[]} */
    const changes = []
    monitor.on('change', ({text}) => changes.push(text))
    monitor.start()
    await Promise.resolve()
    for (let i = 0; i < 4; ++i) { await tick() }
    assert.deepEqual(changes, ['second'])
    assert.equal(timers.size, 1)
    monitor.stop()
    assert.equal(timers.size, 0)
})

test('a failed clipboard read remains retryable', async () => {
    let reads = 0
    const monitor = new ClipboardMonitor({getText: async () => {
        if (++reads === 1) { throw new Error('Permission unavailable') }
        return 'second'
    }})
    /** @type {string[]} */
    const changes = []
    monitor.on('change', ({text}) => changes.push(text))
    monitor.start()
    await Promise.resolve()
    await tick()
    assert.deepEqual(changes, ['second'])
    monitor.stop()
    assert.equal(timers.size, 0)
})

test('setPreviousText continues suppressing a matching clipboard change', async () => {
    let text = 'first'
    const monitor = new ClipboardMonitor({getText: async () => text})
    /** @type {string[]} */
    const changes = []
    monitor.on('change', (event) => changes.push(event.text))
    monitor.start()
    await Promise.resolve()
    monitor.setPreviousText('second')
    text = 'second'
    await tick()
    assert.deepEqual(changes, [])
    monitor.stop()
})
