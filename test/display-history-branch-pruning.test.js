/*
 * Copyright (C) 2026 Manabitan authors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import {afterEach, describe, expect, test, vi} from 'vitest';
import {DisplayHistory} from '../ext/js/display/display-history.js';

/** @param {boolean} useBrowserHistory */
function createHistory(useBrowserHistory) {
    const browserHistory = {state: /** @type {unknown} */ (null), replaceState: vi.fn(), pushState: vi.fn(), back: vi.fn(), forward: vi.fn()};
    vi.stubGlobal('history', browserHistory);
    vi.stubGlobal('location', {href: 'https://example.com/search'});
    const displayHistory = new DisplayHistory(true, useBrowserHistory);
    return {displayHistory, browserHistory};
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('display history branch ownership', () => {
    test.each([false, true])('new searches discard abandoned forward branches (browser history: %s)', (useBrowserHistory) => {
        const {displayHistory, browserHistory} = createHistory(useBrowserHistory);
        const root = displayHistory._current;
        displayHistory.pushState({}, {dictionaryEntries: []});
        const abandonedFirst = displayHistory._current;
        displayHistory.pushState({}, {dictionaryEntries: []});
        const abandonedLast = displayHistory._current;
        if (useBrowserHistory) {
            browserHistory.state = {id: root.id, state: root.state};
            displayHistory._onPopState();
        } else {
            expect(displayHistory.back()).toBe(true);
            expect(displayHistory.back()).toBe(true);
        }
        expect(displayHistory.hasNext()).toBe(true);
        displayHistory.pushState({}, {dictionaryEntries: []});
        expect(displayHistory._historyMap.size).toBe(2);
        expect(displayHistory._historyMap.has(abandonedFirst.id)).toBe(false);
        expect(displayHistory._historyMap.has(abandonedLast.id)).toBe(false);
        expect([abandonedFirst.previous, abandonedFirst.next, abandonedLast.previous, abandonedLast.next]).toEqual([null, null, null, null]);
        expect(displayHistory._current.previous).toBe(root);
        expect(root.next).toBe(displayHistory._current);
        expect(displayHistory.hasNext()).toBe(false);
    });

    test('repeated back-and-search keeps only reachable cached entries', () => {
        const {displayHistory} = createHistory(false);
        for (let i = 0; i < 200; ++i) {
            displayHistory.pushState({}, {dictionaryEntries: []});
            expect(displayHistory._historyMap.size).toBe(2);
            expect(displayHistory.back()).toBe(true);
        }
        displayHistory.pushState({}, {dictionaryEntries: []});
        expect(displayHistory._historyMap.size).toBe(2);
    });

    test('replace preserves forward navigation and new branches preserve back navigation', () => {
        const {displayHistory} = createHistory(false);
        const root = displayHistory._current;
        displayHistory.pushState({}, {dictionaryEntries: []});
        const middle = displayHistory._current;
        displayHistory.pushState({}, {dictionaryEntries: []});
        const last = displayHistory._current;
        displayHistory.back();
        displayHistory.replaceState({}, {dictionaryEntries: []});
        expect(displayHistory.forward()).toBe(true);
        expect(displayHistory._current).toBe(last);
        displayHistory.back();
        displayHistory.pushState({}, {dictionaryEntries: []});
        const replacement = displayHistory._current;
        expect(displayHistory.back()).toBe(true);
        expect(displayHistory._current).toBe(middle);
        expect(displayHistory.back()).toBe(true);
        expect(displayHistory._current).toBe(root);
        expect(displayHistory.forward()).toBe(true);
        expect(displayHistory.forward()).toBe(true);
        expect(displayHistory._current).toBe(replacement);
        expect(displayHistory.forward()).toBe(false);
    });

    test('long linear history remains bounded and clear severs all navigation', () => {
        const {displayHistory} = createHistory(false);
        for (let i = 0; i < 100; ++i) { displayHistory.pushState({}, {dictionaryEntries: []}); }
        expect(displayHistory._historyMap.size).toBe(32);
        displayHistory.clear();
        expect(displayHistory._historyMap.size).toBe(1);
        expect(displayHistory.hasNext()).toBe(false);
        expect(displayHistory.hasPrevious()).toBe(false);
    });
});
