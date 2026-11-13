/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {afterEach, expect, vi} from 'vitest'
import {JsonSchema} from '../ext/js/data/json-schema.js'
import {OptionsUtil} from '../ext/js/data/options-util.js'
import {Display} from '../ext/js/display/display.js'
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js'
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js'
import {createDomTest} from './fixtures/dom-test.js'

const test = createDomTest('ext/search.html')
afterEach(() => { vi.restoreAllMocks() })

/** @type {import('dictionary').KanjiDictionaryEntry} */
const entry = {
    type: 'kanji',
    character: '猫',
    dictionary: 'Test',
    dictionaryAlias: 'Test',
    dictionaryIndex: 0,
    onyomi: ['ビョウ'],
    kunyomi: ['ねこ'],
    definitions: ['cat'],
    tags: [],
    stats: {},
    frequencies: [],
}

/**
 * Use the real history, content publication, lookup dispatch, and templates.
 * Only the browser/backend boundary is replaced.
 * @param {import('jsdom').DOMWindow} window
 * @returns {{display: Display, api: {kanjiFind: import('vitest').Mock}, render: () => Promise<void>}}
 */
function setup(window) {
    const optionsUtil = new OptionsUtil()
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync('ext/data/schemas/options-schema.json', 'utf8')))
    const options = optionsUtil.getDefault().profiles[0].options
    options.dictionaries = [(/** @type {unknown} */ ({name: 'Test', enabled: true}))]
    const api = {
        kanjiFind: vi.fn().mockResolvedValue([entry]),
        drawMedia: vi.fn(),
        optionsGetProfile: async () => ({profileId: 'test-profile', options}),
    }
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api, tabId: 1, frameId: 0, triggerClosePopups() {}, webExtension: {unloaded: false},
    }))
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler())
    display._options = options
    display.history.useBrowserHistory = true
    display._displayGenerator._templates.load(new window.DOMParser().parseFromString(readFileSync('ext/templates-display.html', 'utf8'), 'text/html'))
    vi.spyOn(display, '_setTheme').mockImplementation(() => {})
    vi.spyOn(display, '_updateNestedFrontend').mockResolvedValue()
    vi.spyOn(display, '_updateContentTextScanner').mockImplementation(() => {})
    const render = () => display._onStateChanged()
    display.history.on('stateChanged', () => { void render() })
    return {display, api, render}
}

/**
 * @param {Display} display
 * @param {import('display').HistoryContent|null} content
 * @returns {Promise<import('display').ContentCompletion>}
 */
function publish(display, content) {
    return display.setContent({
        historyMode: 'new',
        focus: false,
        params: {type: 'kanji', query: '猫', lookup: 'false'},
        state: {optionsContext: display.getOptionsContext()},
        content,
    })
}

test.for([false, true])('reloading a scanner result reconstructs its dictionary content (empty=%s)', async (empty, {window}) => {
    const original = setup(window)
    expect(await publish(original.display, {dictionaryEntries: empty ? [] : [entry]})).toBe('completed')
    expect(original.api.kanjiFind).not.toHaveBeenCalled()
    // Browser history is serialized; large lookup results never belong there.
    const savedState = structuredClone(window.history.state)
    expect(JSON.stringify(savedState)).not.toContain('definitions')
    window.history.replaceState(savedState, '', window.location.href)

    const restored = setup(window)
    await restored.display.initializeState()

    expect(restored.api.kanjiFind).toHaveBeenCalledExactlyOnceWith('猫', original.display.getOptionsContext())
    expect(restored.display.dictionaryEntries).toEqual([entry])
    expect(restored.display._container.querySelector('.kanji-glyph')?.textContent).toBe('猫')
    expect(restored.display._container.textContent).toContain('cat')
})

test('browser back recovers scanner content after the complete in-memory history entry is pruned', async ({window}) => {
    const {display, api, render} = setup(window)
    expect(await publish(display, {dictionaryEntries: [entry]})).toBe('completed')
    const oldState = structuredClone(window.history.state)
    const oldUrl = window.location.href
    // Keep this navigation fixture focused on the history cache bound.
    for (let i = 0; i < 34; ++i) {
        display.history.pushState({optionsContext: display.getOptionsContext()}, {dictionaryEntries: []}, `?type=kanji&query=${i}&lookup=false`)
    }
    expect(display.history._historyMap.has(oldState.id)).toBe(false)
    window.history.replaceState(oldState, '', oldUrl)
    display.history._updateStateFromHistory()
    await render()

    expect(api.kanjiFind).toHaveBeenCalledExactlyOnceWith('猫', display.getOptionsContext())
    expect(display.dictionaryEntries).toEqual([entry])
    expect(display._container.textContent).toContain('cat')
    expect(display.history._current.url).toBe(oldUrl)
})

test('reloading after content-only eviction still reconstructs the scanner lookup', async ({window}) => {
    const {display} = setup(window)
    expect(await publish(display, {dictionaryEntries: [entry]})).toBe('completed')
    const original = display.history._current
    display.history.pushState({}, {dictionaryEntries: []}, '?type=kanji&query=犬&lookup=false')
    display.history.pushState({}, {dictionaryEntries: []}, '?type=kanji&query=鳥&lookup=false')
    expect(original.content?.dictionaryEntriesEvicted).toBe(true)
    window.history.replaceState({id: original.id, state: original.state}, '', original.url)
    display.history._updateStateFromHistory()
    // Saving scroll/focus state must retain the reconstruction intent.
    display.history.replaceState(display.history.state, display.history.content)
    const restored = setup(window)
    await restored.display.initializeState()
    expect(restored.api.kanjiFind).toHaveBeenCalledOnce()
    expect(restored.display.dictionaryEntries).toEqual([entry])
})

test.for([{content: null}, {content: {}}])('explicit no-lookup previews remain inert on reload (%j)', async ({content}, {window}) => {
    const original = setup(window)
    expect(await publish(original.display, content)).toBe('completed')
    const restored = setup(window)
    await restored.display.initializeState()
    expect(restored.api.kanjiFind).not.toHaveBeenCalled()
    expect(restored.display.dictionaryEntries).toEqual([])
})

test('replacing a cached result with an explicit preview clears persisted recovery intent', async ({window}) => {
    const original = setup(window)
    expect(await publish(original.display, {dictionaryEntries: [entry]})).toBe('completed')
    original.display.history.replaceState(original.display.history.state, null)
    const restored = setup(window)
    await restored.display.initializeState()
    expect(restored.api.kanjiFind).not.toHaveBeenCalled()
    expect(restored.display.dictionaryEntries).toEqual([])
})
