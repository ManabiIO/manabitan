/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';

const baseUrl = 'chrome-extension://test-extension/search.html';

afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

/**
 * @param {{id: number, url: string|null, mode: import('display').SearchMode}[]} tabs
 * @param {number} [maximumSearchLength]
 * @returns {{backend: Backend, openPopup: import('vitest').MockInstance, focus: import('vitest').MockInstance, update: import('vitest').MockInstance}}
 */
function setup(tabs, maximumSearchLength = 100) {
    vi.useFakeTimers();
    const sendMessage = vi.fn((tabId, {action}, _options, callback) => {
        const tab = tabs.find(({id}) => id === tabId);
        callback({result: action === 'applicationGetUrl' ? {url: tab?.url} : tab?.mode});
    });
    vi.stubGlobal('chrome', {
        runtime: {getURL: (/** @type {string} */ path) => `chrome-extension://test-extension${path}`},
        tabs: {query: (/** @type {unknown} */ _query, /** @type {(tabs: unknown[]) => void} */ callback) => callback(tabs), sendMessage},
    });
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    const popupTab = /** @type {chrome.tabs.Tab} */ ({id: 7, windowId: 70});
    const openPopup = vi.spyOn(backend, '_getOrCreateSearchPopupWrapper').mockResolvedValue({tab: popupTab, created: true});
    const focus = vi.spyOn(backend, '_focusTab').mockResolvedValue();
    const update = vi.spyOn(backend, '_updateSearchQuery').mockResolvedValue();
    vi.spyOn(backend, '_getProfileOptions').mockReturnValue(/** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({
        general: {language: 'ja'},
        clipboard: {maximumSearchLength},
    })));
    return {backend, openPopup, focus, update};
}

test('background clipboard monitoring leaves an existing ordinary search tab in charge', async () => {
    const {backend, openPopup, focus, update} = setup([{id: 1, url: `${baseUrl}?query=猫`, mode: null}]);

    await backend._onClipboardTextChange({text: '日本語'});

    expect(openPopup).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
});

test('background clipboard monitoring also leaves an existing search popup in charge', async () => {
    const {backend, openPopup} = setup([{id: 1, url: baseUrl, mode: 'popup'}]);

    await backend._onClipboardTextChange({text: '日本語'});

    expect(openPopup).not.toHaveBeenCalled();
});

test('background clipboard monitoring opens a popup when no search tab is open', async () => {
    const {backend, openPopup, focus, update} = setup([
        {id: 1, url: 'https://example.test/search.html', mode: null},
        {id: 2, url: 'chrome-extension://test-extension/settings.html', mode: null},
        {id: 3, url: null, mode: null},
    ]);

    await backend._onClipboardTextChange({text: '日本語'});

    expect(openPopup).toHaveBeenCalledExactlyOnceWith();
    expect(focus).toHaveBeenCalledExactlyOnceWith({id: 7, windowId: 70});
    expect(update).toHaveBeenCalledExactlyOnceWith(7, '日本語', false);
});

test('popup reuse still excludes ordinary search tabs', async () => {
    const {backend} = setup([{id: 1, url: baseUrl, mode: null}]);

    expect(await backend._findSearchPopupTab((url) => url?.startsWith(baseUrl) ?? false)).toBeNull();
});

test.each([
    {text: '𠮟る', limit: 1, expected: '𠮟'},
    {text: '日𠮟る', limit: 2, expected: '日𠮟'},
    {text: '𠮟る人', limit: 2, expected: '𠮟る'},
    {text: '日本語', limit: 2, expected: '日本'},
    {text: '𠮟る', limit: 0, expected: ''},
])('background clipboard limits count complete characters: $text / $limit', async ({text, limit, expected}) => {
    const {backend, update} = setup([], limit);
    await backend._onClipboardTextChange({text});
    expect(update).toHaveBeenCalledExactlyOnceWith(7, expected, false);
});

test('popup reuse still selects a popup among ordinary search tabs', async () => {
    const {backend} = setup([
        {id: 1, url: baseUrl, mode: null},
        {id: 2, url: `${baseUrl}?query=犬`, mode: 'popup'},
    ]);

    const result = await backend._findSearchPopupTab((url) => url?.startsWith(baseUrl) ?? false);

    expect(result?.tab.id).toBe(2);
});
