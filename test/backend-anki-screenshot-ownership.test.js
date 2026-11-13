/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, test, vi} from 'vitest'
import {Backend} from '../ext/js/background/backend.js'

/**
 * @template {unknown[]} TArgs
 * @returns {{addListener: (listener: (...args: TArgs) => void) => void, removeListener: (listener: (...args: TArgs) => void) => void, emit: (...args: TArgs) => void, size: () => number}}
 */
function createBrowserEvent() {
    /** @type {Set<(...args: TArgs) => void>} */
    const listeners = new Set()
    return {
        addListener: (listener) => { listeners.add(listener) },
        removeListener: (listener) => { listeners.delete(listener) },
        emit: (...args) => { for (const listener of listeners) { listener(...args) } },
        size: () => listeners.size,
    }
}

function createScreenshotHarness() {
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype))
    const tab = /** @type {chrome.tabs.Tab} */ ({id: 17, windowId: 4, active: true, url: 'https://reader.example/chapter', status: 'complete'})
    const events = {
        onActivated: createBrowserEvent(),
        onUpdated: createBrowserEvent(),
        onRemoved: createBrowserEvent(),
        onDetached: createBrowserEvent(),
    }
    const hooks = {hide: () => {}, capture: () => {}}
    const capture = vi.fn((_windowId, _options, callback) => {
        hooks.capture()
        callback('data:image/png;base64,b3duZXI=')
    })
    const sendMessage = vi.fn((_tabId, message, _options, callback) => {
        if (message.action === 'frontendSetAllVisibleOverride') {
            hooks.hide()
            callback({result: 'visibility-token'})
        } else {
            callback({result: void 0})
        }
    })
    vi.stubGlobal('chrome', {
        runtime: {},
        tabs: {
            ...events,
            get: vi.fn((_tabId, callback) => callback({...tab})),
            sendMessage,
            captureVisibleTab: capture,
        },
    })
    const storeMedia = vi.fn(async (fileName) => fileName)
    const anki = /** @type {import('../ext/js/comm/anki-connect.js').AnkiConnect} */ (/** @type {unknown} */ ({storeMediaFile: storeMedia}))
    Reflect.set(backend, '_getNormalizedDictionaryDatabaseMedia', async () => [])
    const mine = () => backend._injectAnkNoteMedia(
        anki,
        1_797_000_000_000,
        {type: 'kanji', character: '字'},
        null,
        {tabId: 17, frameId: 0, format: 'png', quality: 90},
        null,
        [],
    )
    /**
     * @param {number} tabId
     * @param {number} [windowId]
     */
    const activate = (tabId, windowId = 4) => {
        if (windowId === tab.windowId) { tab.active = tabId === tab.id }
        events.onActivated.emit({tabId, windowId})
    }
    const assertClean = () => {
        for (const event of Object.values(events)) { expect(event.size()).toBe(0) }
    }
    return {backend, tab, events, capture, sendMessage, storeMedia, hooks, mine, activate, assertClean}
}

afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
})

test('mining from an inactive source tab never captures or stores the active tab', async () => {
    const h = createScreenshotHarness()
    h.tab.active = false
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.storeMedia).not.toHaveBeenCalled()
    h.assertClean()
})

test('switching tabs while hiding the popup aborts capture and restores visibility', async () => {
    const h = createScreenshotHarness()
    h.hooks.hide = () => h.activate(18)
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.storeMedia).not.toHaveBeenCalled()
    expect(h.sendMessage).toHaveBeenLastCalledWith(17, {action: 'frontendClearAllVisibleOverride', params: {token: 'visibility-token'}}, {frameId: 0}, expect.any(Function))
    h.assertClean()
})

test('switching away and back during capture cannot publish another tab image', async () => {
    const h = createScreenshotHarness()
    h.hooks.capture = () => {
        h.activate(18)
        h.activate(17)
    }
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(h.capture).toHaveBeenCalledTimes(1)
    expect(h.storeMedia).not.toHaveBeenCalled()
    h.assertClean()
})

test.each(['navigation', 'detached', 'removed'])('a source tab %s during capture discards the image', async (change) => {
    const h = createScreenshotHarness()
    h.hooks.capture = () => {
        if (change === 'navigation') {
            h.events.onUpdated.emit(17, {status: 'loading'}, h.tab)
        } else if (change === 'detached') {
            h.events.onDetached.emit(17, {oldWindowId: 4, oldPosition: 0})
        } else {
            h.events.onRemoved.emit(17, {windowId: 4, isWindowClosing: false})
        }
    }
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(h.storeMedia).not.toHaveBeenCalled()
    h.assertClean()
})

test('a window move observed by the final tab read discards the image', async () => {
    const h = createScreenshotHarness()
    h.hooks.capture = () => { h.tab.windowId = 8 }
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(h.storeMedia).not.toHaveBeenCalled()
    h.assertClean()
})

test('a stable source remains capturable while another window changes its active tab', async () => {
    const h = createScreenshotHarness()
    h.hooks.capture = () => {
        h.activate(33, 9)
        h.events.onUpdated.emit(17, {title: 'Updated title', url: h.tab.url}, h.tab)
    }
    const result = await h.mine()
    expect(result.screenshotFileName).toMatch(/^yomitan_browser_screenshot/)
    expect(result.errors).toEqual([])
    expect(h.capture).toHaveBeenCalledExactlyOnceWith(4, {format: 'png', quality: 90}, expect.any(Function))
    expect(h.storeMedia).toHaveBeenCalledTimes(1)
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    h.assertClean()
})

test('a browser capture failure still releases visibility and event listeners', async () => {
    const h = createScreenshotHarness()
    h.capture.mockImplementation(() => { throw new Error('Capture failed') })
    const result = await h.mine()
    expect(result.screenshotFileName).toBeNull()
    expect(result.errors).toHaveLength(1)
    expect(h.storeMedia).not.toHaveBeenCalled()
    expect(h.sendMessage).toHaveBeenCalledTimes(2)
    h.assertClean()
})
