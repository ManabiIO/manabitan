/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {createAnkiNoteData} from '../ext/js/data/anki-note-data-creator.js';
import {DisplayAnki} from '../ext/js/display/display-anki.js';
import {DisplayHistory} from '../ext/js/display/display-history.js';
import {Display} from '../ext/js/display/display.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

test.for([
    {prefix: '𠮟', storedSentence: false},
    {prefix: '😀𠮟', storedSentence: false},
    {prefix: '犬', storedSentence: false},
    {prefix: '', storedSentence: false},
    {prefix: '𠮟', storedSentence: true},
])('search URLs preserve the mined cloze after Unicode prefixes: %j', async ({prefix, storedSentence}, {window}) => {
    const query = '猫';
    const suffix = 'です';
    const fullQuery = `${prefix}${query}${suffix}`;
    const token = /** @type {import('core').TokenObject} */ ({});
    const display = /** @type {Display} */ (Object.assign(Object.create(Display.prototype), {
        _fullQuery: fullQuery,
        _queryParserVisibleOverride: null,
        _setContentToken: token,
        _options: {dictionaries: []},
        _container: window.document.createElement('div'),
        _dictionaryEntryNodes: [],
        _contentManager: {executeMediaRequests: vi.fn().mockResolvedValue(void 0)},
        _updateQueryParser: vi.fn(),
        _setTitleText: vi.fn(),
        _setOptionsContextIfDifferent: vi.fn().mockResolvedValue(void 0),
        _updateNavigationAuto: vi.fn(),
        _triggerContentUpdateStart: vi.fn(),
        _triggerContentUpdateComplete: vi.fn(),
        _resolveDictionaryCssMedia: vi.fn().mockResolvedValue(void 0),
        getContentOrigin: () => ({tabId: null, frameId: null}),
        getOptionsContext: () => ({current: true}),
    }));
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(display._createSearchParams('kanji', query, false, prefix.length))) {
        if (typeof value === 'string') { params.set(key, value); }
    }
    window.history.replaceState(null, '', `?${params}`);
    display._history = new DisplayHistory(true, true);
    if (storedSentence) {
        display._history.replaceState({sentence: {text: fullQuery, offset: [...prefix].length}}, null);
    }

    await display._setContentTermsOrKanji('kanji', new URLSearchParams(window.location.search), token);

    expect(display.queryOffset).toBe(prefix.length);
    const anki = /** @type {DisplayAnki} */ (Object.assign(Object.create(DisplayAnki.prototype), {_display: display}));
    const context = anki._getNoteContext();
    if (context === null) { throw new Error('Expected a note context'); }
    const data = createAnkiNoteData('cloze-body', {
        dictionaryEntry: {
            type: 'kanji',
            character: query,
            dictionary: 'test',
            dictionaryAlias: 'test',
            dictionaryIndex: 0,
            onyomi: [],
            kunyomi: [],
            definitions: ['cat'],
            tags: [],
            stats: {},
            frequencies: [],
        },
        cardFormat: {type: 'kanji', name: 'Kanji', deck: 'Deck', model: 'Model', fields: {}, icon: 'big-circle'},
        context,
        resultOutputMode: 'split',
        glossaryLayoutMode: 'default',
        compactTags: false,
        media: {},
        dictionaryStylesMap: new Map(),
    });

    expect(data.definition.cloze).toEqual({sentence: fullQuery, prefix, body: query, bodyKana: query, suffix});
});
