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
import {TextSourceRange} from '../ext/js/dom/text-source-range.js'
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js'
import {createDomTest} from './fixtures/dom-test.js'

const test = createDomTest('ext/search.html')
afterEach(() => { vi.restoreAllMocks() })

/** @type {import('dictionary').TermDictionaryEntry} */
const entry = {
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
    maxOriginalTextLength: 3,
    headwords: [{
        index: 0,
        headwordIndex: 0,
        term: 'cat',
        reading: 'cat',
        tags: [],
        wordClasses: [],
        sources: [{originalText: 'cat', transformedText: 'cat', deinflectedText: 'cat', matchType: 'exact', matchSource: 'term', isPrimary: true}],
    }],
    definitions: [{
        index: 0,
        headwordIndices: [0],
        dictionary: 'Test',
        dictionaryIndex: 0,
        dictionaryAlias: 'Test',
        id: 1,
        score: 0,
        frequencyOrder: 0,
        sequences: [1],
        isPrimary: true,
        tags: [],
        entries: ['a small feline'],
    }],
    pronunciations: [],
    frequencies: [],
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {Promise<{display: Display, api: {termsFind: import('vitest').Mock}, publication: import('vitest').MockInstance<Display['setContent']>}>}
 */
async function setup(window) {
    const optionsUtil = new OptionsUtil()
    optionsUtil._optionsSchema = new JsonSchema(JSON.parse(readFileSync('ext/data/schemas/options-schema.json', 'utf8')))
    const options = optionsUtil.getDefault().profiles[0].options
    options.general.language = 'en'
    options.scanning.enablePopupSearch = true
    options.scanning.enableOnSearchPage = true
    options.scanning.layoutAwareScan = false
    options.sentenceParsing.scanExtent = 0
    options.dictionaries = [{name: 'Test', alias: 'Test', enabled: true, allowSecondarySearches: false, definitionsCollapsible: 'not-collapsible', partsOfSpeechFilter: false, useDeinflections: true}]
    const api = {
        termsFind: vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0}),
        kanjiFind: vi.fn().mockResolvedValue([]),
        parseText: vi.fn().mockResolvedValue([]),
        drawMedia: vi.fn(),
        optionsGetProfile: async () => ({profileId: 'test-profile', options}),
    }
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api, tabId: 1, frameId: 0, triggerClosePopups() {}, webExtension: {unloaded: false},
    }))
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler())
    display._languageSummaries = [{name: 'English', iso: 'en', iso639_3: 'eng', exampleText: 'cat'}]
    display.history.useBrowserHistory = true
    display._displayGenerator._templates.load(new window.DOMParser().parseFromString(readFileSync('ext/templates-display.html', 'utf8'), 'text/html'))
    vi.spyOn(display, '_setTheme').mockImplementation(() => {})
    vi.spyOn(display, '_updateNestedFrontend').mockResolvedValue()
    display.history.on('stateChanged', () => { void display._onStateChanged() })
    display._queryParser.prepare()
    display._queryParser.on('searched', display._onQueryParserSearch.bind(display))
    await display.updateOptions()
    return {display, api, publication: vi.spyOn(display, 'setContent')}
}

test.for(['definition', 'query-parser'].flatMap((route) => [false, true].map((unavailable) => ({route, unavailable}))))('$route scanner publishes its completed result without repeating the lookup (unavailable=$unavailable)', async ({route, unavailable}, {window}) => {
    const {display, api, publication} = await setup(window)
    const scanner = route === 'definition' ? display._contentTextScanner : display._queryParser._textScanner
    if (scanner === null) { throw new Error('Content scanner was not prepared') }
    const errors = vi.fn()
    scanner.on('searchError', errors)
    const sourceNode = window.document.createElement('span')
    sourceNode.className = 'click-scannable'
    sourceNode.textContent = 'cat'
    const sourceContainer = route === 'definition' ? display._container : display._queryParser._queryParser
    sourceContainer.append(sourceNode)
    const range = window.document.createRange()
    range.setStart(/** @type {Text} */ (sourceNode.firstChild), 0)
    range.collapse(true)
    const source = TextSourceRange.create(range)
    /** @type {import('translator').DictionaryAvailability[]} */
    const dictionaryAvailability = [{dictionary: 'Test', generationId: 'generation-1', status: 'repairing', reason: 'index missing'}]
    api.termsFind.mockResolvedValueOnce({
        dictionaryEntries: unavailable ? [] : [entry],
        originalTextLength: unavailable ? 0 : 3,
        ...(unavailable ? {dictionaryAvailability} : {}),
    })
    // A later read can observe a different database state. Publication must
    // use the completed scanner response, including incomplete-result status.
    try {
        await scanner.search(source)
        expect(errors).not.toHaveBeenCalled()
        expect(publication).toHaveBeenCalledOnce()
        expect(await publication.mock.results[0].value).toBe('completed')
        if (unavailable) {
            expect(display.dictionaryEntries).toEqual([])
            expect(window.document.querySelector('.footer-notification-body')?.textContent ?? '').toContain('being repaired')
            expect(window.document.querySelector('#no-results')?.hasAttribute('hidden')).toBe(true)
        } else {
            expect(display.dictionaryEntries).toEqual([entry])
            expect(display._container.querySelector('.headword-term')?.textContent).toBe('cat')
            expect(display._container.textContent).toContain('a small feline')
        }
        expect(api.termsFind).toHaveBeenCalledOnce()
    } finally {
        display._contentTextScanner?.setEnabled(false)
        display._queryParser._textScanner.setEnabled(false)
    }
})
