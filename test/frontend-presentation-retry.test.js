/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {log} from '../ext/js/core/log.js';
import {TextSourceElement} from '../ext/js/dom/text-source-element.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {setupDomTest} from './fixtures/dom-test.js';

const environment = await setupDomTest();
/** @type {TextScanner[]} */
const scanners = [];
afterEach(() => {
    for (const scanner of scanners.splice(0)) { scanner.setEnabled(false); }
    document.body.replaceChildren();
    vi.restoreAllMocks();
});
afterAll(async () => { await environment.teardown(global); });

/**
 * @param {string} text
 * @returns {TextSourceElement}
 */
function source(text) {
    const button = document.createElement('button');
    button.textContent = text;
    document.body.append(button);
    return TextSourceElement.create(button);
}

/** @returns {import('text-scanner').InputInfo} */
function input() {
    return {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null};
}

function setup() {
    const lookup = vi.fn().mockResolvedValue({
        dictionaryEntries: [{dictionary: 'JMdict', type: 'term', definitions: []}], originalTextLength: 1,
    });
    /** @type {TextSourceElement[]} */
    const sources = [];
    const scanner = new TextScanner({
        api: /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({termsFind: lookup})),
        browser: 'chrome',
        node: window,
        searchTerms: true,
        searchKanji: false,
        getSearchContext: () => ({optionsContext: {depth: 0, url: 'https://example.test/'}, detail: {documentTitle: 'presentation'}}),
        textSourceGenerator: /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({
            getRangeFromPoint: () => sources.shift() ?? null,
            extractSentence: () => ({text: '', offset: 0}),
        })),
    });
    scanner.prepare();
    scanner.setEnabled(true);
    scanner.setOptions({scanLength: 20});
    scanners.push(scanner);
    const show = vi.fn().mockResolvedValue(void 0);
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    for (const [key, value] of Object.entries({
        _textScanner: scanner,
        _application: {tabId: 1, frameId: 0, webExtension: {unloaded: false}},
        _popup: {showContent: show},
        _lastShowPromise: Promise.resolve(),
        _clearSelectionRequest: null,
        _debugSearchSuccessCount: 0,
        _updatePageDebugState: vi.fn(),
    })) { Reflect.set(frontend, key, value); }
    scanner.on('searchSuccess', frontend._onSearchSuccess.bind(frontend));
    scanner.on('searchError', frontend._onSearchError.bind(frontend));
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    /** @param {TextSourceElement} selected */
    const scan = async (selected) => {
        sources.push(selected.clone());
        await Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, input());
    };
    return {frontend, scanner, lookup, show, report, scan};
}

test('returning to the same word during auto-hide initiates a fresh lookup', async () => {
    const {frontend, scanner, lookup, scan} = setup();
    const word = source('cat');
    Reflect.set(frontend, '_options', {scanning: {autoHideResults: true, hideDelay: 100}});
    Reflect.set(frontend, '_debugSearchEmptyCount', 0);
    const hide = vi.spyOn(frontend, '_clearSelectionDelayed').mockResolvedValue(void 0);
    scanner.on('searchEmpty', frontend._onSearchEmpty.bind(frontend));

    await scan(word);
    await frontend.showContentCompleted();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(scanner.hasSelection()).toBe(true);

    // The scanner has no text under this coordinate; the frontend schedules
    // automatic hiding but intentionally retains the old selected anchor.
    await Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, input());
    expect(hide).toHaveBeenCalledWith(100, false, false);
    expect(scanner.hasSelection()).toBe(true);

    // Without a retry marker the same-start fast path incorrectly no-ops,
    // letting the pending hide dismiss the popup under the returning cursor.
    await scan(word);
    await frontend.showContentCompleted();
    expect(lookup).toHaveBeenCalledTimes(2);
});

test('same-word no-op remains intact when automatic hiding is disabled', async () => {
    const {frontend, scanner, lookup, scan} = setup();
    const word = source('cat');
    Reflect.set(frontend, '_options', {scanning: {autoHideResults: false, hideDelay: 100}});
    Reflect.set(frontend, '_debugSearchEmptyCount', 0);
    const hide = vi.spyOn(frontend, '_clearSelectionDelayed').mockResolvedValue(void 0);
    scanner.on('searchEmpty', frontend._onSearchEmpty.bind(frontend));

    await scan(word);
    await Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, input());
    await scan(word);

    expect(lookup).toHaveBeenCalledTimes(1);
    expect(hide).not.toHaveBeenCalled();
});

test('failed content delivery allows the same word to be hovered again without clearing its anchor', async () => {
    const {frontend, scanner, lookup, show, report, scan} = setup();
    const word = source('cat');
    const failure = new Error('Popup transport unavailable');
    show.mockRejectedValueOnce(failure);
    await scan(word);
    await frontend.showContentCompleted().catch(() => {});
    const selected = scanner.getCurrentTextSource();
    expect(selected?.hasSameStart(word)).toBe(true);
    expect(report).toHaveBeenCalledExactlyOnceWith(failure);
    await scan(word);
    await frontend.showContentCompleted();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(show).toHaveBeenCalledTimes(2);
    // Healthy repeated hover regains the no-op fast path.
    await scan(word);
    expect(lookup).toHaveBeenCalledTimes(2);
});

for (const failurePoint of ['geometry', 'show']) {
    test(`synchronous ${failurePoint} publication failure permits a later same-position hover`, async () => {
        const {scanner, lookup, show, report, scan} = setup();
        const word = source('cat');
        const failure = new Error('Popup setup unavailable');
        if (failurePoint === 'geometry') {
            vi.spyOn(TextSourceElement.prototype, 'getRects').mockImplementationOnce(() => { throw failure; });
        } else {
            show.mockImplementationOnce(() => { throw failure; });
        }
        await scan(word);
        expect(report).toHaveBeenCalledExactlyOnceWith(failure);
        expect(scanner.getCurrentTextSource()?.hasSameStart(word)).toBe(true);
        await scan(word);
        expect(lookup).toHaveBeenCalledTimes(2);
    });
}

test('late failure of an older show does not invalidate the latest successful selection', async () => {
    const {frontend, scanner, lookup, show, scan} = setup();
    const older = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    show.mockReturnValueOnce(older.promise);
    await scan(source('cat'));
    const latest = source('dog');
    await scan(latest);
    older.reject(new Error('Obsolete popup failure'));
    await Promise.resolve();
    await scan(latest);
    expect(scanner.getCurrentTextSource()?.hasSameStart(latest)).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
    await frontend.showContentCompleted();
});

test('failure after dismissal cannot revive the old source or poison a fresh selection', async () => {
    const {scanner, lookup, show, scan} = setup();
    const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    show.mockReturnValueOnce(pending.promise);
    await scan(source('cat'));
    scanner.cancelPendingSearches();
    scanner.clearSelection();
    pending.reject(new Error('Dismissed popup failure'));
    await Promise.resolve();
    expect(scanner.hasSelection()).toBe(false);
    const next = source('dog');
    await scan(next);
    await scan(next);
    expect(lookup).toHaveBeenCalledTimes(2);
});

test('position-only failure does not force healthy dictionary content to be looked up again', async () => {
    const {frontend, scanner, lookup, show, scan} = setup();
    const word = source('cat');
    await scan(word);
    const selected = /** @type {TextSourceElement} */ (scanner.getCurrentTextSource());
    show.mockRejectedValueOnce(new Error('Position update unavailable'));
    await frontend._showPopupContent(selected, null, null).catch(() => {});
    await scan(word);
    expect(lookup).toHaveBeenCalledTimes(1);
});

test('retry admission retains selection-restoration state even when selection clearing is disabled', async () => {
    const {frontend, scanner, lookup, show, scan} = setup();
    scanner.canClearSelection = false;
    const restore = {ranges: [document.createRange()]};
    Reflect.set(scanner, '_selectionRestoreInfo', restore);
    show.mockRejectedValueOnce(new Error('Content unavailable'));
    const word = source('cat');
    await scan(word);
    Reflect.set(scanner, '_selectionRestoreInfo', restore);
    await frontend.showContentCompleted().catch(() => {});
    expect(scanner.hasSelection()).toBe(true);
    expect(Reflect.get(scanner, '_selectionRestoreInfo')).toBe(restore);
    await scan(word);
    expect(lookup).toHaveBeenCalledTimes(2);
});

test('repeated delivery failure remains retryable without automatic background lookups', async () => {
    const {frontend, lookup, show, scan} = setup();
    show.mockRejectedValue(new Error('Content remains unavailable'));
    const word = source('cat');
    await scan(word);
    await frontend.showContentCompleted().catch(() => {});
    const lookupCountBeforeInput = lookup.mock.calls.length;
    await scan(word);
    await frontend.showContentCompleted().catch(() => {});
    expect(lookupCountBeforeInput).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(2);
});

test('a superseded show of the same source cannot invalidate the later successful delivery', async () => {
    const {frontend, scanner, lookup, show, scan} = setup();
    const pending = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    show.mockReturnValueOnce(pending.promise);
    const word = source('cat');
    await scan(word);
    const selected = /** @type {TextSourceElement} */ (scanner.getCurrentTextSource());
    const details = /** @type {import('display').ContentDetails} */ (show.mock.calls[0][1]);
    await frontend._showPopupContent(selected, null, details);
    pending.reject(new Error('Superseded delivery'));
    await Promise.resolve();
    await scan(word);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(2);
});

test('an unrelated same-position clone cannot invalidate the current source', async () => {
    const {frontend, scanner, lookup, show, scan} = setup();
    const word = source('cat');
    await scan(word);
    const selected = /** @type {TextSourceElement} */ (scanner.getCurrentTextSource());
    const details = /** @type {import('display').ContentDetails} */ (show.mock.calls[0][1]);
    show.mockRejectedValueOnce(new Error('Unrelated presentation failed'));
    await frontend._showPopupContent(selected.clone(), null, details).catch(() => {});
    await scan(word);
    expect(lookup).toHaveBeenCalledTimes(1);
});
