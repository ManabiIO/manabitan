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
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

describe('Display lookup refresh', () => {
    test('term lookup uses freshly loaded enabled dictionaries when options were initially null', async ({window}) => {
        window.document.body.innerHTML = `
            <div id="no-results" hidden></div>
            <div id="no-dictionaries" hidden></div>
        `;

        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        display._options = null;
        display._history = {state: {}, content: {}};
        display._setContentToken = 'token';
        display._container = window.document.createElement('div');
        display._dictionaryEntryNodes = [];
        display._windowScroll = {stop() {}, to() {}};
        display._contentManager = {executeMediaRequests() {}};
        display._elementOverflowController = {addElements() {}};
        display._displayGenerator = {};
        display._dictionaryInfo = [];
        display._setQuery = vi.fn();
        display._setOptionsContextIfDifferent = vi.fn().mockResolvedValue(void 0);
        display.updateOptions = vi.fn().mockImplementation(async () => {
            display._options = {dictionaries: [{enabled: true}]};
        });
        display._findDictionaryEntries = vi.fn().mockResolvedValue([]);
        display._replaceHistoryStateNoNavigate = vi.fn();
        display.getOptionsContext = vi.fn(() => ({depth: 0}));
        display.getContentOrigin = vi.fn(() => ({tabId: null, frameId: null}));
        display._updateNavigationAuto = vi.fn();
        display._setNoContentVisible = vi.fn();
        display._setNoDictionariesVisible = vi.fn();
        display._triggerContentUpdateStart = vi.fn();
        display._triggerContentUpdateComplete = vi.fn();
        display._triggerContentUpdateEntry = vi.fn();
        display._addEntryEventListeners = vi.fn();
        display._focusEntry = vi.fn();

        const urlSearchParams = new URLSearchParams({query: '名前'});
        await display._setContentTermsOrKanji('terms', urlSearchParams, 'token');

        expect(display.updateOptions).toHaveBeenCalledOnce();
        expect(display._findDictionaryEntries).toHaveBeenCalledOnce();
        expect(display._setNoDictionariesVisible).toHaveBeenCalledWith(false);
        expect(display._setNoContentVisible).toHaveBeenCalledWith(true);
    });

    test('searchLast preserves disabled lookup mode across refreshes', async ({window}) => {
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        display._contentType = 'terms';
        display._query = '暗記';
        display._fullQuery = '暗記';
        display._queryOffset = 0;
        display._primaryReading = '';
        display._lookup = false;
        display._wildcardsEnabled = false;
        display._optionsContext = {depth: 0, url: window.location.href};
        display._history = {state: null};
        display.getContentOrigin = vi.fn(() => ({tabId: 1, frameId: 1}));
        display.setContent = vi.fn();

        display.searchLast(false);

        expect(display.setContent).toHaveBeenCalledOnce();
        expect(display.setContent.mock.calls[0][0].params.lookup).toBe('false');
        expect(display.setContent.mock.calls[0][0].params.wildcards).toBe('off');
    });

    test('large result rendering yields in batches instead of once per entry', async ({window}) => {
        const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, _timeout, ...args) => {
            if (typeof handler === 'function') {
                handler(...args);
            }
            return /** @type {ReturnType<typeof setTimeout>} */ (0);
        });
        const performanceNowSpy = vi.spyOn(window.performance, 'now').mockReturnValue(0);

        try {
            window.document.body.innerHTML = `
                <div id="no-results" hidden></div>
                <div id="no-dictionaries" hidden></div>
            `;

            const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
            display._options = {dictionaries: [{enabled: true}]};
            display._history = {state: {}, content: {}};
            display._setContentToken = 'token';
            display._container = window.document.createElement('div');
            display._dictionaryEntryNodes = [];
            display._windowScroll = {stop() {}, to() {}};
            display._contentManager = {executeMediaRequests() {}};
            display._elementOverflowController = {addElements() {}};
            display._displayGenerator = {
                createTermEntry: vi.fn(() => window.document.createElement('div')),
                createKanjiEntry: vi.fn(() => window.document.createElement('div')),
            };
            display._dictionaryInfo = [];
            display._setQuery = vi.fn();
            display._setOptionsContextIfDifferent = vi.fn().mockResolvedValue(void 0);
            display.updateOptions = vi.fn().mockResolvedValue(void 0);
            display._findDictionaryEntries = vi.fn().mockResolvedValue(
                Array.from({length: 100}, () => ({type: 'term'})),
            );
            display._replaceHistoryStateNoNavigate = vi.fn();
            display.getOptionsContext = vi.fn(() => ({depth: 0}));
            display.getContentOrigin = vi.fn(() => ({tabId: null, frameId: null}));
            display._updateNavigationAuto = vi.fn();
            display._setNoContentVisible = vi.fn();
            display._setNoDictionariesVisible = vi.fn();
            display._triggerContentUpdateStart = vi.fn();
            display._triggerContentUpdateComplete = vi.fn();
            display._triggerContentUpdateEntry = vi.fn();
            display._addEntryEventListeners = vi.fn();
            display._focusEntry = vi.fn();
            const urlSearchParams = new URLSearchParams({query: '言'});
            await display._setContentTermsOrKanji('terms', urlSearchParams, 'token');

            expect(display._container.childElementCount).toBe(100);
            expect(setTimeoutSpy).toHaveBeenCalledTimes(3);
        } finally {
            performanceNowSpy.mockRestore();
            setTimeoutSpy.mockRestore();
        }
    });

    test('searchLast preserves primary reading across refreshes', async ({window}) => {
        const display = /** @type {Display} */ (/** @type {unknown} */ (Object.create(Display.prototype)));
        display._contentType = 'terms';
        display._query = '自重';
        display._fullQuery = '自重';
        display._queryOffset = 0;
        display._primaryReading = 'じちょう';
        display._lookup = true;
        display._wildcardsEnabled = false;
        display._optionsContext = {depth: 0, url: window.location.href};
        display._history = {state: null};
        display.getContentOrigin = vi.fn(() => ({tabId: 1, frameId: 1}));
        display.setContent = vi.fn();

        display.searchLast(false);

        expect(display.setContent).toHaveBeenCalledOnce();
        expect(display.setContent.mock.calls[0][0].params.primary_reading).toBe('じちょう');
    });
});
