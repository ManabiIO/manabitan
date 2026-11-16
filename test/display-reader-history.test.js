/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
/* eslint @stylistic/semi: ["error", "never"] */

import {readFileSync} from 'node:fs'
import {afterEach, expect, vi} from 'vitest'
import {Frontend} from '../ext/js/app/frontend.js'
import {installReaderLookupIntegration} from '../ext/js/app/reader-lookup-integration.js'
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js'
import {JsonSchema} from '../ext/js/data/json-schema.js'
import {OptionsUtil} from '../ext/js/data/options-util.js'
import {Display} from '../ext/js/display/display.js'
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js'
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js'
import {createDomTest} from './fixtures/dom-test.js'

const test = createDomTest('ext/search.html')
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

/**
 * @param {string} term
 * @param {string} reading
 * @param {string} definition
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function createEntry(term, reading, definition) {
    return {
        type: 'term',
        isPrimary: true,
        textProcessorRuleChainCandidates: [],
        inflectionRuleChainCandidates: [],
        score: 0,
        frequencyOrder: 0,
        dictionaryIndex: 0,
        dictionaryAlias: 'Test',
        sourceTermExactMatchCount: 1,
        matchPrimaryReading: false,
        maxOriginalTextLength: term.length,
        headwords: [{index: 0, headwordIndex: 0, term, reading, tags: [], wordClasses: [], sources: [{originalText: term, transformedText: term, deinflectedText: term, matchType: 'exact', matchSource: 'term', isPrimary: true}]}],
        definitions: [{index: 0, headwordIndices: [0], dictionary: 'Test', dictionaryIndex: 0, dictionaryAlias: 'Test', id: 1, score: 0, frequencyOrder: 0, sequences: [1], isPrimary: true, tags: [], entries: [definition]}],
        pronunciations: [],
        frequencies: [],
    }
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {import('vitest').Mock} termsFind
 * @returns {Display}
 */
function createDisplay(window, termsFind) {
    const optionsUtil = new OptionsUtil()
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync('ext/data/schemas/options-schema.json', 'utf8')))
    const options = optionsUtil.getDefault().profiles[0].options
    options.dictionaries = [{name: 'Test', alias: 'Test', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: false, useDeinflections: true}]
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api: {termsFind, kanjiFind: vi.fn().mockResolvedValue([]), drawMedia() {}, optionsGetProfile: async () => ({profileId: 'test-profile', options})},
        tabId: 1,
        frameId: 0,
        triggerClosePopups() {},
        webExtension: {unloaded: false},
    }))
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler())
    display._options = options
    display._languageSummaries = [{name: 'Japanese', iso: 'ja', iso639_3: 'jpn', exampleText: '日本語'}]
    display.history.useBrowserHistory = true
    display._displayGenerator._templates.load(new window.DOMParser().parseFromString(readFileSync('ext/templates-display.html', 'utf8'), 'text/html'))
    vi.spyOn(display, '_setTheme').mockImplementation(() => {})
    vi.spyOn(display, '_updateNestedFrontend').mockResolvedValue()
    vi.spyOn(display, '_updateContentTextScanner').mockImplementation(() => {})
    display.history.on('stateChanged', () => { void display._onStateChanged() })
    return display
}

/**
 * Use the production reader projection, source span, Frontend content details,
 * and Display rendering. Only the cross-frame transport is in-process.
 * @param {Display} display
 * @param {import('../ext/js/app/reader-lookup-bridge.js').ReaderLookup} request
 * @returns {Promise<void>}
 */
async function publishReader(display, request) {
    vi.stubGlobal('matchMedia', () => ({matches: false}))
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype))
    Object.assign(frontend, {
        _options: display.getOptions(),
        _disabledOverride: false,
        _application: display.application,
        _getOptionsContext: async () => ({depth: 0, url: 'https://reader.example/chapter'}),
        _textScanner: {setCurrentTextSource() {}},
    })
    frontend._showPopupContent = (_source, _optionsContext, details) => {
        if (details === null) { throw new Error('Reader content was missing') }
        const publication = display.setContent(details).then((result) => { expect(result).toBe('completed') })
        frontend._lastShowPromise = publication
        return publication
    }
    const bridge = installReaderLookupIntegration(frontend)
    try {
        const anchor = document.createElement('span')
        anchor.textContent = request.surface
        await Reflect.get(bridge, '_show')(request, anchor, () => true, () => () => {})
    } finally {
        bridge.dispose()
    }
}

/**
 * @param {Display} display
 * @param {import('jsdom').DOMWindow} window
 * @param {import('vitest').Mock} termsFind
 * @param {string} action
 * @returns {Promise<Display>}
 */
async function reconstruct(display, window, termsFind, action) {
    if (action === 'reload') {
        const restored = createDisplay(window, termsFind)
        await restored.initializeState()
        return restored
    }
    if (action === 'eviction') {
        const state = structuredClone(window.history.state)
        const url = window.location.href
        display.history.pushState({}, {dictionaryEntries: []}, '?type=terms&query=one&lookup=false')
        display.history.pushState({}, {dictionaryEntries: []}, '?type=terms&query=two&lookup=false')
        window.history.replaceState(state, '', url)
        display.history._updateStateFromHistory()
        await display._onStateChanged()
        return display
    }
    const publication = vi.spyOn(display, 'setContent')
    await display._refreshAfterOptionsUpdate()
    expect(await publication.mock.results[0].value).toBe('completed')
    return display
}

test.for(['reload', 'eviction', 'refresh'])('reader exact reading survives $0', async (action, {window}) => {
    const other = createEntry('生', 'せい', 'life')
    const requested = createEntry('生', 'なま', 'raw')
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [other, requested], originalTextLength: 1})
    const display = createDisplay(window, termsFind)
    await publishReader(display, {protocol: 1, term: '生', reading: 'なま', surface: '生', sentence: '生です。', offset: 0})
    expect(display.dictionaryEntries).toHaveLength(1)
    expect(display._container.textContent).toContain('raw')
    termsFind.mockClear()

    const restored = await reconstruct(display, window, termsFind, action)

    expect(restored.dictionaryEntries).toHaveLength(1)
    expect(restored._container.textContent).toContain('raw')
    expect(restored._container.textContent).not.toContain('life')
    expect(termsFind).toHaveBeenCalledExactlyOnceWith('生', {matchType: 'exact', deinflect: false, primaryReading: 'なま'}, restored.getOptionsContext())
})

test.for(['reload', 'refresh'])('reader inflected surface remains the Anki cloze after $0', async (action, {window}) => {
    const entry = createEntry('見る', 'みる', 'to see')
    const termsFind = vi.fn(async (/** @type {string} */ query) => ({
        dictionaryEntries: [{...entry, maxOriginalTextLength: query.length, headwords: entry.headwords.map((headword) => ({...headword, sources: headword.sources.map((source) => ({...source, originalText: query}))}))}],
        originalTextLength: query.length,
    }))
    const display = createDisplay(window, termsFind)
    await publishReader(display, {protocol: 1, term: '見る', reading: 'みる', surface: '見られなかった', sentence: '😀見られなかった。', offset: 2})
    termsFind.mockClear()

    const restored = await reconstruct(display, window, termsFind, action)
    const data = createAnkiNoteData('cloze-body', {
        dictionaryEntry: restored.dictionaryEntries[0],
        cardFormat: {type: 'term', name: 'Reader', deck: 'Default', model: 'Basic', fields: {}, icon: 'big-circle'},
        resultOutputMode: 'split',
        glossaryLayoutMode: 'default',
        compactTags: false,
        context: {sentence: /** @type {import('display').HistoryStateSentence} */ (restored.history.state?.sentence), url: '', documentTitle: '', query: restored.query, fullQuery: restored.fullQuery},
        media: void 0,
        dictionaryStylesMap: new Map(),
    })
    expect(data.definition.cloze).toMatchObject({prefix: '😀', body: '見られなかった', suffix: '。'})
    expect(termsFind).toHaveBeenCalledExactlyOnceWith('見る', {matchType: 'exact', deinflect: false, primaryReading: 'みる'}, restored.getOptionsContext())
})

test('reader reconstruction does not substitute a different reading when the exact result disappears', async ({window}) => {
    const other = createEntry('生', 'せい', 'life')
    const requested = createEntry('生', 'なま', 'raw')
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [other, requested], originalTextLength: 1})
    const display = createDisplay(window, termsFind)
    await publishReader(display, {protocol: 1, term: '生', reading: 'なま', surface: '生', sentence: '生です。', offset: 0})
    termsFind.mockResolvedValue({dictionaryEntries: [other], originalTextLength: 1})

    const restored = await reconstruct(display, window, termsFind, 'reload')

    expect(restored.dictionaryEntries).toEqual([])
    expect(restored._container.textContent).not.toContain('life')
})

test('an ordinary lookup of the same text does not inherit the reader reading filter', async ({window}) => {
    const entries = [createEntry('生', 'せい', 'life'), createEntry('生', 'なま', 'raw')]
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: entries, originalTextLength: 1})
    const display = createDisplay(window, termsFind)
    await publishReader(display, {protocol: 1, term: '生', reading: 'なま', surface: '生', sentence: '生です。', offset: 0})
    termsFind.mockClear()

    expect(await display.setContent({
        historyMode: 'new',
        focus: false,
        params: {type: 'terms', query: '生'},
        state: {optionsContext: display.getOptionsContext()},
        content: null,
    })).toBe('completed')

    expect(display.dictionaryEntries).toHaveLength(2)
    expect(termsFind).toHaveBeenCalledExactlyOnceWith('生', {primaryReading: ''}, display.getOptionsContext())
})

test('changing the query invalidates reader forms retained in history state', async ({window}) => {
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [createEntry('生', 'なま', 'raw')], originalTextLength: 1})
    const display = createDisplay(window, termsFind)
    await publishReader(display, {protocol: 1, term: '生', reading: 'なま', surface: '生', sentence: '生です。', offset: 0})
    termsFind.mockClear()
    termsFind.mockResolvedValue({dictionaryEntries: [createEntry('猫', 'ねこ', 'cat')], originalTextLength: 1})

    expect(await display.setContent({
        historyMode: 'overwrite',
        focus: false,
        params: {type: 'terms', query: '猫'},
        state: display.history.state,
        content: null,
    })).toBe('completed')

    expect(display._container.textContent).toContain('cat')
    expect(termsFind).toHaveBeenCalledExactlyOnceWith('猫', {primaryReading: ''}, display.getOptionsContext())
})
