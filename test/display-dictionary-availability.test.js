/*
 * Copyright (C) 2026  Yomitan Authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import {describe, expect, vi} from 'vitest';
import {Display} from '../ext/js/display/display.js';
import {DisplayNotification} from '../ext/js/display/display-notification.js';
import {QueryParser} from '../ext/js/display/query-parser.js';
import {Frontend} from '../ext/js/app/frontend.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
const optionsContext = {depth: 0, url: 'https://example.test/'};
/** @type {import('translator').DictionaryAvailability[]} */
const degraded = [{dictionary: 'Damaged', generationId: 'generation-1', status: 'repairing', reason: 'index missing'}];
/** @type {import('dictionary').TermDictionaryEntry} */
const healthyEntry = /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({type: 'term', definitions: [{dictionary: 'Healthy'}]}));

/**
 * @param {Document} document
 * @returns {{display: Display, notification: DisplayNotification, footer: HTMLDivElement, termsFind: ReturnType<typeof vi.fn>, kanjiFind: ReturnType<typeof vi.fn>, createTermEntry: ReturnType<typeof vi.fn>}}
 */
function createDisplay(document) {
    document.body.innerHTML = '<div id="no-results" hidden></div><div id="no-dictionaries" hidden></div>';
    const footer = document.createElement('div');
    document.body.appendChild(footer);
    const noticeNode = document.createElement('div');
    noticeNode.innerHTML = '<div class="footer-notification-body"></div><button class="footer-notification-close-button"></button>';
    const notification = new DisplayNotification(footer, noticeNode);
    const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: []});
    const kanjiFind = vi.fn().mockResolvedValue([]);
    const createTermEntry = vi.fn(() => {
        const entry = document.createElement('div');
        entry.textContent = 'Healthy sibling';
        return entry;
    });
    Object.assign(display, {
        _pageType: 'search',
        _fullQuery: '日本',
        _history: {state: {optionsContext}, content: {}},
        _options: {dictionaries: [{name: 'Healthy', enabled: true}, {name: 'Damaged', enabled: true}]},
        _application: {api: {termsFind, kanjiFind}},
        _setContentToken: {},
        _dictionaryAvailabilityNotification: null,
        _container: document.createElement('div'),
        _dictionaryEntryNodes: [],
        _windowScroll: {x: 0, y: 0},
        _dictionaryInfo: [],
        _contentManager: {executeMediaRequests: async () => {}, unloadAll() {}},
        _elementOverflowController: {addElements() {}, clearElements() {}},
        _displayGenerator: {createTermEntry},
        _setQuery: vi.fn(),
        _setOptionsContextIfDifferent: vi.fn().mockResolvedValue(void 0),
        _replaceHistoryStateNoNavigate: vi.fn(),
        _updateNavigationAuto: vi.fn(),
        _triggerContentUpdateStart: vi.fn(),
        _triggerContentUpdateComplete: vi.fn(),
        _triggerContentUpdateEntry: vi.fn(),
        _triggerContentClear: vi.fn(),
        _addEntryEventListeners: vi.fn(),
        _focusEntry: vi.fn(),
        _resolveDictionaryCssMedia: vi.fn().mockResolvedValue(void 0),
        _reportTermsFindSnapshot: vi.fn(),
        getContentOrigin: () => ({tabId: null, frameId: null}),
        getLanguageSummary: () => ({iso: 'ja'}),
        createNotification: vi.fn(() => notification),
        _closePopups: vi.fn(),
        _closeAllPopupMenus: vi.fn(),
        _eventListeners: {removeAllEventListeners() {}},
    });
    return {display, notification, footer, termsFind, kanjiFind, createTermEntry};
}

/**
 * @param {Display} display
 * @param {import('display').HistoryContent} content
 */
async function showSuppliedContent(display, content) {
    /** @type {import('core').TokenObject} */
    const token = {};
    Reflect.set(display, '_history', {state: {optionsContext}, content});
    display._setContentToken = token;
    display._dictionaryEntryNodes = [];
    await display._setContentTermsOrKanji('terms', new URLSearchParams({query: '日本', lookup: 'false'}), token);
}

describe('Display incomplete lookup rendering', () => {
    test('incomplete empty search hides ordinary No results and shows repair notice', async ({window}) => {
        const {display, termsFind, kanjiFind, notification} = createDisplay(window.document);
        termsFind.mockResolvedValue({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability: degraded});
        const result = await display._findDictionaryEntries(false, '日本', '', false, optionsContext);
        expect(result).toEqual({dictionaryEntries: [], dictionaryAvailability: degraded});
        expect(kanjiFind).not.toHaveBeenCalled();
        await display._setContentTermsOrKanji('terms', new URLSearchParams({query: '日本'}), /** @type {import('core').TokenObject} */ (display._setContentToken));
        expect(window.document.querySelector('#no-results')?.hasAttribute('hidden')).toBe(true);
        expect(notification.isClosed()).toBe(false);
        expect(notification.node.textContent).toContain('Damaged');
        expect(notification.node.textContent).toContain('being repaired');
        expect(notification.node.textContent).not.toContain('index missing');
    });

    test('partial popup results render healthy siblings while warning only about affected dictionaries', async ({window}) => {
        const {display, notification, createTermEntry} = createDisplay(window.document);
        await showSuppliedContent(display, {dictionaryEntries: [healthyEntry], dictionaryAvailability: degraded});
        expect(display.dictionaryEntries).toEqual([healthyEntry]);
        expect(createTermEntry).toHaveBeenCalledTimes(1);
        expect(display._container.textContent).toBe('Healthy sibling');
        expect(notification.node.textContent).toContain('Damaged');
        expect(notification.node.textContent).not.toContain('Healthy');
        expect(window.document.querySelector('#no-results')?.hasAttribute('hidden')).toBe(true);
    });

    test('a subsequent healthy supplied popup closes the degraded notification', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        expect(notification.isClosed()).toBe(false);
        await showSuppliedContent(display, {dictionaryEntries: [healthyEntry]});
        expect(notification.isClosed()).toBe(true);
        expect(display.dictionaryEntries).toEqual([healthyEntry]);
    });

    test('fresh healthy lookup clears a stale availability field stored in history', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        const token = display._setContentToken;
        await display._setContentTermsOrKanji('terms', new URLSearchParams({query: '日本'}), /** @type {import('core').TokenObject} */ (token));
        expect(notification.isClosed()).toBe(true);
        expect(display._history.content?.dictionaryAvailability).toBeUndefined();
        expect(window.document.querySelector('#no-results')?.hasAttribute('hidden')).toBe(false);
    });

    test('a stale content token can neither open nor clear the current notice', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        /** @type {import('core').TokenObject} */
        const stale = {};
        display._updateDictionaryAvailability(degraded, stale);
        expect(notification.isClosed()).toBe(true);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        display._updateDictionaryAvailability(void 0, stale);
        expect(notification.isClosed()).toBe(false);
    });

    test('a late incomplete lookup cannot reopen a notification after healthy replacement content', async ({window}) => {
        const {display, termsFind, notification} = createDisplay(window.document);
        const lookup = Promise.withResolvers();
        termsFind.mockReturnValueOnce(lookup.promise);
        const pending = display._setContentTermsOrKanji('terms', new URLSearchParams({query: '日本'}), /** @type {import('core').TokenObject} */ (display._setContentToken));
        await vi.waitFor(() => { expect(termsFind).toHaveBeenCalledTimes(1); });
        await showSuppliedContent(display, {dictionaryEntries: [healthyEntry]});
        lookup.resolve({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability: degraded});
        await pending;
        expect(notification.isClosed()).toBe(true);
        expect(display.dictionaryEntries).toEqual([healthyEntry]);
    });

    test('invalidating the search draft immediately hides the previous notice', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        display.invalidateSearchDraft();
        expect(notification.isClosed()).toBe(true);
    });

    test('clear and unloaded content hide the previous notification', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        Reflect.set(display, '_updateNavigation', vi.fn());
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        display._clearContent();
        expect(notification.isClosed()).toBe(true);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: degraded});
        display._setContentExtensionUnloaded();
        expect(notification.isClosed()).toBe(true);
    });

    for (const [status, message] of /** @type {const} */ ([
        ['repairPending', 'being repaired'],
        ['repairing', 'being repaired'],
        ['temporarilyUnavailable', 'temporarily unavailable'],
        ['reimportRequired', 'Reimport this dictionary'],
    ])) {
        test(`${status} has an actionable notification`, async ({window}) => {
            const {display, notification} = createDisplay(window.document);
            await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: [{...degraded[0], status, reason: null}]});
            expect(notification.node.textContent).toContain(message);
        });
    }

    test('dictionary names and reasons are rendered as text, not markup', async ({window}) => {
        const {display, notification} = createDisplay(window.document);
        await showSuppliedContent(display, {dictionaryEntries: [], dictionaryAvailability: [{...degraded[0], dictionary: '<img src=x>', reason: '<script>bad()</script>'}]});
        expect(notification.node.querySelector('img, script')).toBeNull();
        expect(notification.node.textContent).toContain('<img src=x>');
    });

    test('kanji-to-term fallback also retains incomplete availability', async ({window}) => {
        const {display, termsFind, kanjiFind} = createDisplay(window.document);
        termsFind.mockResolvedValue({dictionaryEntries: [], dictionaryAvailability: degraded});
        expect(await display._findDictionaryEntries(true, '日', '', false, optionsContext)).toEqual({dictionaryEntries: [], dictionaryAvailability: degraded});
        expect(kanjiFind).toHaveBeenCalledTimes(1);
    });
});

describe('popup and in-display scanner forwarding', () => {
    test('status-only prewarm results are not counted as dictionary matches', async ({window}) => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability: degraded});
        Object.assign(frontend, {_application: {api: {termsFind}}});
        const {firstMatchedResultPromise, resultsPromise} = frontend._runLookupPrewarmTerms(['日本', 'する'], optionsContext);
        expect(await firstMatchedResultPromise).toBeNull();
        expect(await resultsPromise).toEqual([{term: '日本', dictionaryEntries: []}, {term: 'する', dictionaryEntries: []}]);
        expect(termsFind).toHaveBeenCalledTimes(2);
        expect(window.document.querySelector('.footer-notification-body')).toBeNull();
    });

    test('Frontend forwards scanner status through popup HistoryContent', ({window}) => {
        const frontend = /** @type {Frontend} */ (/** @type {unknown} */ (Object.create(Frontend.prototype)));
        const show = vi.fn();
        Object.assign(frontend, {
            _debugSearchSuccessCount: 0,
            _application: {tabId: 1, frameId: 2},
            _updatePageDebugState: vi.fn(),
            _stopClearSelectionDelayed: vi.fn(),
            _showPopupContent: show,
        });
        const textSource = /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({text: () => '日'}));
        frontend._onSearchSuccess({
            type: 'terms',
            dictionaryEntries: [],
            dictionaryAvailability: degraded,
            sentence: {text: '日本', offset: 0},
            textSource,
            optionsContext,
            inputInfo: {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null},
            detail: {documentTitle: window.document.title},
            pageTheme: 'light',
        });
        expect(show.mock.calls[0][2].content.dictionaryAvailability).toBe(degraded);
        expect(show.mock.calls[0][2].params.lookup).toBe('false');
    });

    test('QueryParser forwards scanner status into Display history', ({window}) => {
        const {display} = createDisplay(window.document);
        const setContent = vi.fn();
        Reflect.set(display, 'setContent', setContent);
        const parser = /** @type {QueryParser} */ (/** @type {unknown} */ (Object.create(QueryParser.prototype)));
        const textSource = /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({text: () => '日'}));
        Object.assign(parser, {
            _getSentenceOffset: () => 0,
            trigger: (/** @type {string} */ _name, /** @type {import('query-parser').EventArgument<'searched'>} */ details) => display._onQueryParserSearch(details),
        });
        parser._onSearchSuccess({
            type: 'terms',
            dictionaryEntries: [],
            dictionaryAvailability: degraded,
            sentence: {text: '日本', offset: 0},
            textSource,
            optionsContext,
            inputInfo: {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null},
            detail: {documentTitle: ''},
            pageTheme: 'light',
        });
        expect(setContent.mock.calls[0][0].content.dictionaryAvailability).toBe(degraded);
    });

    test('Display content scanner forwards degraded status into history', ({window}) => {
        const {display} = createDisplay(window.document);
        const setContent = vi.fn();
        Reflect.set(display, 'setContent', setContent);
        Reflect.set(display, '_contentTextScanner', {clearSelection: vi.fn()});
        const textSource = /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({text: () => '日'}));
        display._onContentTextScannerSearchSuccess({
            type: 'terms',
            dictionaryEntries: [],
            dictionaryAvailability: degraded,
            sentence: {text: '日本', offset: 0},
            textSource,
            optionsContext,
            inputInfo: {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null},
            detail: {documentTitle: ''},
            pageTheme: 'light',
        });
        expect(setContent.mock.calls[0][0].content.dictionaryAvailability).toBe(degraded);
    });
});
