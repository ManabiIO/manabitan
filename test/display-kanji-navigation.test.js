/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {DocumentFocusController} from '../ext/js/dom/document-focus-controller.js';
import {HotkeyHandler} from '../ext/js/input/hotkey-handler.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest('ext/search.html');
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {string} character
 * @returns {import('dictionary').KanjiDictionaryEntry[]}
 */
function entries(character) {
    const entry = /** @type {import('dictionary').KanjiDictionaryEntry} */ (/** @type {unknown} */ ({type: 'kanji', character}));
    return [entry];
}

/**
 * @returns {{display: Display, kanjiFind: import('vitest').Mock<(query: string) => Promise<import('dictionary').KanjiDictionaryEntry[]>>, termsFind: import('vitest').Mock, report: import('vitest').MockInstance<Display['onError']>, publish: import('vitest').MockInstance<Display['setContent']>, click: (query: string) => Promise<void>, settle: () => Promise<void>}}
 */
function setup() {
    const kanjiFind = /** @type {import('vitest').Mock<(query: string) => Promise<import('dictionary').KanjiDictionaryEntry[]>>} */ (/** @type {unknown} */ (vi.fn(async (/** @type {string} */ query) => entries(query))));
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: []});
    const application = /** @type {import('../ext/js/application.js').Application} */ (/** @type {unknown} */ ({
        api: {kanjiFind, termsFind}, tabId: 1, frameId: 2, triggerClosePopups: vi.fn(), webExtension: {unloaded: false},
    }));
    const display = new Display(application, 'search', new DocumentFocusController(), new HotkeyHandler());
    display._options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{enabled: true}]}));
    vi.spyOn(display, '_setOptionsContextIfDifferent').mockResolvedValue(void 0);
    vi.spyOn(display, '_setTheme').mockImplementation(() => {});
    vi.spyOn(display, '_focusEntry').mockImplementation(() => {});
    vi.spyOn(display, '_reportTermsFindSnapshot').mockImplementation(() => {});
    vi.spyOn(display, '_resolveDictionaryCssMedia').mockResolvedValue(void 0);
    vi.spyOn(display._contentManager, 'executeMediaRequests').mockResolvedValue(void 0);
    vi.spyOn(display, 'getLanguageSummary').mockReturnValue(/** @type {import('language').LanguageSummary} */ (/** @type {unknown} */ ({iso: 'en'})));
    vi.spyOn(display.displayGenerator, 'createKanjiEntry').mockImplementation((entry) => {
        const node = document.createElement('div');
        node.textContent = entry.character;
        return node;
    });
    const report = vi.spyOn(display, 'onError').mockImplementation(() => {});
    const publish = vi.spyOn(display, 'setContent');
    const state = {
        optionsContext: display.getOptionsContext(),
        sentence: {text: 'source sentence', offset: 3},
        url: 'https://example.test/source',
        documentTitle: 'Source title',
    };
    display.history.replaceState(state, null, '?type=terms&query=source');
    display._historyHasChanged = true;
    display._fullQuery = 'source';
    /** @type {Promise<void>[]} */
    const renders = [];
    display.history.on('stateChanged', () => { renders.push(display._onStateChanged()); });
    return {
        display,
        kanjiFind,
        termsFind,
        report,
        publish,
        click: (query) => {
            const node = document.createElement('a');
            node.textContent = query;
            const preventDefault = vi.fn();
            const operation = display._onKanjiLookup(/** @type {MouseEvent} */ (/** @type {unknown} */ ({currentTarget: node, preventDefault})));
            expect(preventDefault).toHaveBeenCalledOnce();
            return Promise.resolve(operation);
        },
        settle: async () => {
            let count = -1;
            while (count !== renders.length) {
                count = renders.length;
                await Promise.all(renders);
            }
        },
    };
}

test('a kanji link performs one lookup and retains source context', async ({window: _window}) => {
    const {display, kanjiFind, termsFind, report, click, settle} = setup();
    await click('\u65e5');
    await settle();
    expect(kanjiFind).toHaveBeenCalledExactlyOnceWith('\u65e5', display.getOptionsContext());
    expect(termsFind).not.toHaveBeenCalled();
    expect(display._container.textContent).toBe('\u65e5');
    expect(display.history.state).toMatchObject({
        sentence: {text: 'source sentence', offset: 3}, url: 'https://example.test/source', documentTitle: 'Source title',
    });
    expect(display.history.content?.contentOrigin).toEqual({tabId: 1, frameId: 2});
    expect(report).not.toHaveBeenCalled();
});

test('kanji navigation is admitted before the backend responds', async ({window: _window}) => {
    const {display, kanjiFind, click, settle} = setup();
    const pending = /** @type {PromiseWithResolvers<import('dictionary').KanjiDictionaryEntry[]>} */ (Promise.withResolvers());
    kanjiFind.mockReturnValueOnce(pending.promise);
    const operation = click('\u65e5');
    try {
        expect(new URLSearchParams(location.search).get('query')).toBe('\u65e5');
        expect(display._contentType).toBe('kanji');
    } finally {
        pending.resolve(entries('\u65e5'));
        await operation;
        await settle();
    }
});

test.for(['newer-click', 'draft', 'back'])('a late kanji response cannot replace %s', async (action, {window: _window}) => {
    const {display, kanjiFind, report, publish, click, settle} = setup();
    const pending = /** @type {PromiseWithResolvers<import('dictionary').KanjiDictionaryEntry[]>} */ (Promise.withResolvers());
    kanjiFind.mockReturnValueOnce(pending.promise);
    const operation = click('\u65e5');
    try {
        await vi.waitFor(() => { expect(kanjiFind).toHaveBeenCalledOnce(); });
        switch (action) {
            case 'newer-click': await click('\u672c'); break;
            case 'draft': display.invalidateSearchDraft(); break;
            case 'back': display.history.back(); break;
        }
        const expectedLocation = location.href;
        const publications = publish.mock.calls.length;
        pending.resolve(entries('\u65e5'));
        await operation;
        await settle();
        expect(location.href).toBe(expectedLocation);
        expect(publish).toHaveBeenCalledTimes(publications);
        expect(display._container.textContent).not.toBe('\u65e5');
        expect(report).not.toHaveBeenCalled();
    } finally {
        pending.resolve(entries('\u65e5'));
        await operation;
        await settle();
    }
});

test('a disabled dictionary set does not send a kanji request', async ({window: _window}) => {
    const {display, kanjiFind, termsFind, click, settle} = setup();
    if (display._options === null) { throw new Error('Missing options'); }
    display._options.dictionaries[0].enabled = false;
    await click('\u65e5');
    await settle();
    expect(kanjiFind).not.toHaveBeenCalled();
    expect(termsFind).not.toHaveBeenCalled();
    expect(display._container.textContent).toBe('');
});

test('missing kanji entries retain the normal term fallback', async ({window: _window}) => {
    const {kanjiFind, termsFind, report, click, settle} = setup();
    kanjiFind.mockResolvedValue([]);
    await click('\u65e5');
    await settle();
    expect(kanjiFind).toHaveBeenCalledOnce();
    expect(termsFind).toHaveBeenCalledOnce();
    expect(report).not.toHaveBeenCalled();
});

test('lookup failure is reported and a subsequent click recovers', async ({window: _window}) => {
    const {display, kanjiFind, report, click, settle} = setup();
    const error = new Error('Dictionary unavailable');
    kanjiFind.mockRejectedValueOnce(error);
    await click('\u65e5');
    await settle();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    await click('\u672c');
    await settle();
    expect(display._container.textContent).toBe('\u672c');
    expect(display._stateChangeCompleteResolvers).toHaveLength(0);
});

test('an obsolete lookup rejection cannot report an error over a newer successful lookup', async ({window: _window}) => {
    const {display, kanjiFind, report, click, settle} = setup();
    const pending = /** @type {PromiseWithResolvers<import('dictionary').KanjiDictionaryEntry[]>} */ (Promise.withResolvers());
    kanjiFind.mockReturnValueOnce(pending.promise);
    const operation = click('\u65e5');
    try {
        await vi.waitFor(() => { expect(kanjiFind).toHaveBeenCalledOnce(); });
        await click('\u672c');
        pending.reject(new Error('Old dictionary request failed'));
        await operation;
        await settle();
        expect(display._container.textContent).toBe('\u672c');
        expect(report).not.toHaveBeenCalled();
    } finally {
        pending.resolve(entries('\u65e5'));
        await operation;
        await settle();
    }
});
