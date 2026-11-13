/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {afterEach, expect, vi} from 'vitest'
import {SearchDisplayController} from '../ext/js/display/search-display-controller.js'
import {createDomTest} from './fixtures/dom-test.js'

const test = createDomTest('ext/search.html')
afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

/**
 * Keep the real polling, Search copy handler, clipboard change validation,
 * and search publication. Only the clipboard and Display boundary are replaced.
 * @param {import('vitest').Mock<() => Promise<string>>} getText
 * @param {Document} document
 * @returns {{controller: SearchDisplayController, publish: import('vitest').Mock}}
 */
function setup(getText, document) {
    vi.useFakeTimers()
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    const publish = vi.fn().mockResolvedValue('completed')
    const display = /** @type {import('../ext/js/display/display.js').Display} */ (/** @type {unknown} */ ({
        application: {api: {clipboardGet: getText, isTextLookupWorthy: async () => true}, tabId: 1, frameId: 0, webExtension: {unloaded: false}},
        getOptions: () => ({general: {language: 'ja'}, clipboard: {autoSearchContent: true, maximumSearchLength: 1000}}),
        depth: 0,
        setContent: publish,
    }))
    const controller = new SearchDisplayController(
        display,
        /** @type {import('../ext/js/display/display-audio.js').DisplayAudio} */ (/** @type {unknown} */ ({})),
        /** @type {import('../ext/js/display/search-persistent-state-controller.js').SearchPersistentStateController} */ (/** @type {unknown} */ ({})),
    )
    controller._clipboardMonitorEnabled = true
    controller._queryInput.value = '元の検索'
    controller._clipboardMonitor.on('change', controller._onClipboardMonitorChange.bind(controller))
    return {controller, publish}
}

test.for(['\n読む \t', '\u3000読む\u3000'])('copying Search text with surrounding whitespace does not replace the current search (%j)', async (copied, {window}) => {
    let clipboard = '初期値'
    const getText = vi.fn(async () => clipboard)
    const {controller, publish} = setup(getText, window.document)
    const monitor = controller._clipboardMonitor
    try {
        monitor.start()
        await vi.advanceTimersByTimeAsync(0)
        clipboard = copied
        await controller._onCopy()

        await vi.advanceTimersByTimeAsync(250)

        expect(publish).not.toHaveBeenCalled()
        expect(controller._queryInput.value).toBe('元の検索')
        clipboard = '外部のコピー'
        await vi.advanceTimersByTimeAsync(250)
        expect(publish).toHaveBeenCalledOnce()
        expect(publish.mock.calls[0][0]).toMatchObject({historyMode: 'clear', params: {query: '外部のコピー'}})
    } finally {
        monitor.stop()
    }
})

test.for([false, true])('a pending clipboard poll cannot undo a newer Search copy baseline (initial=%s)', async (initial, {window}) => {
    const pending = /** @type {PromiseWithResolvers<string>} */ (Promise.withResolvers())
    let clipboard = '初期値'
    const getText = vi.fn(async () => clipboard)
    const {controller, publish} = setup(getText, window.document)
    const monitor = controller._clipboardMonitor
    try {
        if (initial) { getText.mockReturnValueOnce(pending.promise) }
        monitor.start()
        if (!initial) {
            await vi.advanceTimersByTimeAsync(0)
            getText.mockReturnValueOnce(pending.promise)
            vi.advanceTimersByTime(250)
        }
        clipboard = '自分でコピーした語'
        await controller._onCopy()
        // The older transport response was captured before this page's copy.
        pending.resolve('古いクリップボード')
        await vi.advanceTimersByTimeAsync(250)

        expect(publish).not.toHaveBeenCalled()
        expect(controller._queryInput.value).toBe('元の検索')
        clipboard = '外部のコピー'
        await vi.advanceTimersByTimeAsync(250)
        expect(publish).toHaveBeenCalledOnce()
        expect(publish.mock.calls[0][0]).toMatchObject({params: {query: '外部のコピー'}})
    } finally {
        pending.resolve('古いクリップボード')
        monitor.stop()
    }
})
