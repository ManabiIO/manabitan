/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterAll, afterEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {TextSourceElement} from '../ext/js/dom/text-source-element.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
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
 * Real source identity and independent clones are essential: a fake source with
 * hasSameStart always returning false would hide the refresh defect.
 * @param {string} text
 * @returns {TextSourceElement}
 */
function source(text) {
    const element = document.createElement('button');
    element.textContent = text;
    document.body.append(element);
    return TextSourceElement.create(element);
}

/**
 * @param {string} dictionary
 * @param {number} [length]
 * @returns {import('api').ApiReturn<'termsFind'>}
 */
function hit(dictionary, length = 1) {
    const entry = /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({dictionary, definitions: []}));
    return {dictionaryEntries: [entry], originalTextLength: length};
}

/** @returns {import('text-scanner').InputInfo} */
function input() { return {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null}; }

/** @returns {{scanner: TextScanner, lookup: import('vitest').Mock, success: import('vitest').Mock, error: import('vitest').Mock, empty: import('vitest').Mock, sources: TextSourceElement[]}} */
function setup() {
    /** @type {TextSourceElement[]} */
    const sources = [];
    const lookup = vi.fn().mockResolvedValue(hit('initial'));
    const scanner = new TextScanner({
        browser: 'chrome',
        node: window,
        api: /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({termsFind: lookup, isTextLookupWorthy: async () => false})),
        searchTerms: true,
        searchKanji: false,
        getSearchContext: () => ({optionsContext: {depth: 0, url: 'https://example.test/', modifiers: [], modifierKeys: [], pointerType: 'mouse'}, detail: {documentTitle: 'rescan'}}),
        textSourceGenerator: /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({
            getRangeFromPoint: () => sources.shift() ?? null,
            extractSentence: () => ({text: '', offset: 0}),
        })),
    });
    scanner.prepare();
    scanner.setEnabled(true);
    scanner.setOptions({scanLength: 20});
    scanners.push(scanner);
    const success = vi.fn();
    const error = vi.fn();
    const empty = vi.fn();
    scanner.on('searchSuccess', success);
    scanner.on('searchError', error);
    scanner.on('searchEmpty', empty);
    return {scanner, lookup, success, error, empty, sources};
}

/**
 * @param {TextScanner} scanner
 * @returns {Promise<void>}
 */
function scan(scanner) { return Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, input()); }

test('searchLast actually queries the selected source and publishes updated definitions', async () => {
    const {scanner, lookup, success} = setup();
    const selected = source('猫');
    await scanner.search(selected);
    lookup.mockResolvedValueOnce(hit('updated'));
    const handled = await scanner.searchLast();
    expect(handled).toBe(true);
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(success).toHaveBeenLastCalledWith(expect.objectContaining({dictionaryEntries: [expect.objectContaining({dictionary: 'updated'})]}));
    expect(scanner.getCurrentTextSource()?.hasSameStart(selected)).toBe(true);
});

test('explicit script search at the same position is not treated as a hover no-op', async () => {
    const {scanner, lookup} = setup();
    const selected = source('猫');
    await scanner.search(selected);
    await scanner.search(selected.clone());
    expect(lookup).toHaveBeenCalledTimes(2);
});

test('ordinary repeated hover still avoids redundant API work', async () => {
    const {scanner, lookup, sources} = setup();
    const selected = source('猫');
    sources.push(selected, selected.clone());
    await scan(scanner);
    await scan(scanner);
    expect(lookup).toHaveBeenCalledTimes(1);
});

test('searchLast without a selected source reports no work', async () => {
    const {scanner, lookup} = setup();
    expect(await scanner.searchLast()).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
});

test('refresh preserves the original pointer input and modifier context', async () => {
    const {scanner, lookup, sources, success} = setup();
    sources.push(source('猫'));
    await scan(scanner);
    await scanner.searchLast();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(success.mock.lastCall?.[0].inputInfo).toMatchObject({pointerType: 'mouse', eventType: 'mouseMove'});
});

test('dictionary update handler refreshes a healthy selected word, not only incomplete results', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫'));
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    for (const [key, value] of Object.entries({
        _textScanner: scanner,
        _optionsUpdateToken: null,
        _dictionaryUpdateSearchCount: 0,
        _application: {webExtension: {unloaded: false}},
        _updatePageDebugState: vi.fn(),
        updateOptions: vi.fn().mockResolvedValue(void 0),
        _startPopupPrewarmForHover: vi.fn(),
        _clearSelection: vi.fn(),
        _clearMousePosition: vi.fn(),
    })) { Reflect.set(frontend, key, value); }
    lookup.mockResolvedValueOnce(hit('reimported'));
    await frontend._onDatabaseUpdated({type: 'dictionary', cause: 'import'});
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(success.mock.lastCall?.[0].dictionaryEntries[0].dictionary).toBe('reimported');
});

test('delayed refresh does not mutate the published source while a newer selection wins', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫犬'));
    const selected = scanner.getCurrentTextSource();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    if (!refreshStarted) { lookup.mockReset().mockResolvedValue(hit('fresh')); }
    await scanner.search(source('鳥'));
    pending.resolve(hit('obsolete', 2));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(selected?.text()).toBe('猫');
    expect(scanner.getCurrentTextSource()?.text()).toBe('鳥');
    expect(success).toHaveBeenCalledTimes(2);
});

test('a newer hover wins over an old delayed refresh', async () => {
    const {scanner, lookup, success, sources} = setup();
    await scanner.search(source('猫'));
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    if (!refreshStarted) { lookup.mockReset().mockResolvedValue(hit('fresh')); }
    sources.push(source('犬'));
    await scan(scanner);
    pending.resolve(hit('obsolete'));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(scanner.getCurrentTextSource()?.text()).toBe('犬');
    expect(success).toHaveBeenCalledTimes(2);
});

test('a refresh beginning during a manual lookup does not cancel the manual result', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫'));
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hit('updated-cat'));
    const manual = scanner.search(source('犬'));
    await scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 3;
    pending.resolve(hit('new-dog'));
    await manual;
    expect(refreshStarted).toBe(true);
    expect(scanner.getCurrentTextSource()?.text()).toBe('犬');
    expect(success.mock.lastCall?.[0].dictionaryEntries[0].dictionary).toBe('new-dog');
});

test('overlapping refreshes publish only the newest dictionary result', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫'));
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hit('latest'));
    const older = scanner.searchLast();
    await scanner.searchLast();
    const queryCount = lookup.mock.calls.length;
    pending.resolve(hit('obsolete'));
    await older;
    expect(queryCount).toBe(3);
    expect(success).toHaveBeenCalledTimes(2);
    expect(success.mock.lastCall?.[0].dictionaryEntries[0].dictionary).toBe('latest');
});

test('overlapping manual searches cannot restore an older word after the newest result', async () => {
    const {scanner, lookup, success} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hit('latest'));
    const older = scanner.search(source('猫'));
    await scanner.search(source('犬'));
    pending.resolve(hit('obsolete'));
    await older;
    expect(scanner.getCurrentTextSource()?.text()).toBe('犬');
    expect(success).toHaveBeenCalledTimes(1);
});

test('a late manual failure does not replace a newer successful search with an error', async () => {
    const {scanner, lookup, error} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const older = scanner.search(source('猫'));
    await scanner.search(source('犬'));
    pending.reject(new Error('Obsolete manual search'));
    await older;
    expect(error).not.toHaveBeenCalled();
});

test('a late manual miss does not hide a newer successful search', async () => {
    const {scanner, lookup, empty} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const older = scanner.search(source('猫'));
    await scanner.search(source('犬'));
    pending.resolve({dictionaryEntries: [], originalTextLength: 0});
    await older;
    expect(empty).not.toHaveBeenCalled();
});

test('a new manual scan invalidates a previously active hover result', async () => {
    const {scanner, lookup, sources, success} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    sources.push(source('猫'));
    const pointer = scan(scanner);
    await scanner.search(source('犬'));
    pending.resolve(hit('obsolete'));
    await pointer;
    expect(scanner.getCurrentTextSource()?.text()).toBe('犬');
    expect(success).toHaveBeenCalledTimes(1);
});

test('a newer hover invalidates a previously active manual result', async () => {
    const {scanner, lookup, sources, success} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const manual = scanner.search(source('猫'));
    sources.push(source('犬'));
    await scan(scanner);
    pending.resolve(hit('obsolete'));
    await manual;
    expect(scanner.getCurrentTextSource()?.text()).toBe('犬');
    expect(success).toHaveBeenCalledTimes(1);
});

test('same-position hover no-op does not invalidate a pending refresh', async () => {
    const {scanner, lookup, sources, success} = setup();
    const selected = source('猫');
    await scanner.search(selected);
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    sources.push(selected.clone());
    await scan(scanner);
    pending.resolve(hit('updated'));
    await refresh;
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(success.mock.lastCall?.[0].dictionaryEntries[0].dictionary).toBe('updated');
});

test('clearing selection invalidates a pending refresh without canceling ordinary replacement work', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫'));
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    scanner.clearSelection();
    pending.resolve(hit('obsolete'));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
    expect(scanner.hasSelection()).toBe(false);
});

test('refresh preserves selection restoration metadata', async () => {
    const {scanner} = setup();
    await scanner.search(source('猫'));
    const restore = {ranges: [document.createRange()]};
    Reflect.set(scanner, '_selectionRestoreInfo', restore);
    await scanner.searchLast();
    expect(Reflect.get(scanner, '_selectionRestoreInfo')).toBe(restore);
});

test('real DOM-range hover sources can be refreshed without losing their anchor', async () => {
    const {scanner, lookup} = setup();
    const element = document.createElement('span');
    element.textContent = '猫犬';
    document.body.append(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    const selected = TextSourceRange.create(range);
    const sources = Reflect.get(scanner, '_textSourceGenerator');
    vi.spyOn(sources, 'getRangeFromPoint').mockReturnValueOnce(selected);
    await scan(scanner);
    lookup.mockResolvedValueOnce(hit('updated-range', 2));
    await scanner.searchLast();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(scanner.getCurrentTextSource()?.text()).toBe('猫犬');
    expect(scanner.getCurrentTextSource()?.hasSameStart(selected)).toBe(true);
    expect(selected.text()).toBe('猫');
});

test('a current refresh failure is reported and a subsequent refresh can recover', async () => {
    const {scanner, lookup, success, error} = setup();
    await scanner.search(source('猫'));
    lookup.mockRejectedValueOnce(new Error('Temporary dictionary failure'));
    await scanner.searchLast();
    const failureCount = error.mock.calls.length;
    lookup.mockResolvedValueOnce(hit('recovered'));
    await scanner.searchLast();
    expect(failureCount).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(3);
    expect(success.mock.lastCall?.[0].dictionaryEntries[0].dictionary).toBe('recovered');
});

test('a late refresh failure cannot report an error for a newer selected word', async () => {
    const {scanner, lookup, error} = setup();
    await scanner.search(source('猫'));
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    if (!refreshStarted) { lookup.mockReset().mockResolvedValue(hit('fresh')); }
    await scanner.search(source('犬'));
    // Attach an observer even on a baseline that never started the refresh API.
    void pending.promise.catch(() => {});
    pending.reject(new Error('Obsolete refresh'));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(error).not.toHaveBeenCalled();
});

test('refresh clones do not take cleanup ownership from the source creator', async () => {
    const {scanner, lookup} = setup();
    await scanner.search(source('猫'));
    const selected = /** @type {TextSourceElement} */ (scanner.getCurrentTextSource());
    const clone = selected.clone.bind(selected);
    const cleanup = vi.fn();
    vi.spyOn(selected, 'clone').mockImplementation(() => {
        const result = clone();
        vi.spyOn(result, 'cleanup').mockImplementation(cleanup);
        return result;
    });
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    scanner.cancelPendingSearches();
    scanner.clearSelection();
    const cleanupBeforeSettlement = cleanup.mock.calls.length;
    pending.resolve(hit('obsolete'));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(cleanupBeforeSettlement).toBe(0);
    expect(cleanup).not.toHaveBeenCalled();
});

test('manual scan releases pointer admission but not the old reader source', async () => {
    const {scanner, lookup, sources} = setup();
    const selected = source('猫');
    const cleanup = vi.spyOn(selected, 'cleanup');
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    sources.push(selected, source('鳥'));
    const older = scan(scanner);
    await scanner.search(source('犬'));
    const busyAfterManual = Reflect.get(scanner, '_pendingLookup');
    const cleanedBeforeSettlement = cleanup.mock.calls.length;
    await scan(scanner);
    pending.resolve(hit('obsolete'));
    await older;
    expect(busyAfterManual).toBe(false);
    expect(cleanedBeforeSettlement).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(scanner.getCurrentTextSource()?.text()).toBe('鳥');
});

test('a current refresh publication failure is reported rather than mistaken for a stale result', async () => {
    const {scanner, success, error, lookup} = setup();
    await scanner.search(source('猫'));
    success.mockImplementationOnce(() => { throw new Error('Current display failure'); });
    await scanner.searchLast();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.lastCall?.[0].error.message).toBe('Current display failure');
});

test('a cleared refresh cannot revive if its original source is installed again', async () => {
    const {scanner, lookup, success} = setup();
    await scanner.search(source('猫'));
    const selected = scanner.getCurrentTextSource();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const refresh = scanner.searchLast();
    const refreshStarted = lookup.mock.calls.length === 2;
    scanner.clearSelection();
    scanner.setCurrentTextSource(selected);
    pending.resolve(hit('obsolete'));
    await refresh;
    expect(refreshStarted).toBe(true);
    expect(success).toHaveBeenCalledTimes(1);
});

test('overlapping manual requests sharing a source cannot mutate the newer published range', async () => {
    const {scanner, lookup, success} = setup();
    const selected = source('猫犬');
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(hit('latest', 1));
    const older = scanner.search(selected);
    await scanner.search(selected);
    pending.resolve(hit('obsolete', 2));
    await older;
    expect(scanner.getCurrentTextSource()?.text()).toBe('猫');
    expect(success).toHaveBeenCalledTimes(1);
});

test('a caller source is not mutated or cleaned by a manual lookup', async () => {
    const {scanner} = setup();
    const selected = source('猫犬');
    const cleanup = vi.spyOn(selected, 'cleanup');
    await scanner.search(selected);
    expect(selected.text()).toBe('');
    expect(cleanup).not.toHaveBeenCalled();
    expect(scanner.getCurrentTextSource()?.text()).toBe('猫');
    expect(scanner.getCurrentTextSource()).not.toBe(selected);
    expect(scanner.getCurrentTextSource()?.hasSameStart(selected)).toBe(true);
});

test('manual and refresh clones preserve a caller-owned temporary DOM element', async () => {
    const {scanner} = setup();
    const imposter = document.createElement('span');
    imposter.textContent = '猫犬';
    const inputElement = document.createElement('input');
    document.body.append(imposter, inputElement);
    const range = document.createRange();
    range.selectNodeContents(imposter);
    const selected = new TextSourceRange(range, 0, range.toString(), imposter, inputElement, [], null, false);
    await scanner.search(selected);
    await scanner.searchLast();
    expect(imposter.isConnected).toBe(true);
    expect(selected.text()).toBe('猫犬');
    selected.cleanup();
    expect(imposter.isConnected).toBe(false);
});

test('refresh retains a kanji-only input group instead of switching to term results', async () => {
    const {scanner, lookup, sources, success} = setup();
    const kanji = /** @type {import('dictionary').KanjiDictionaryEntry} */ (/** @type {unknown} */ ({dictionary: 'kanji'}));
    const kanjiFind = vi.fn().mockResolvedValue([kanji]);
    Reflect.set(scanner, '_searchKanji', true);
    Reflect.get(scanner, '_api').kanjiFind = kanjiFind;
    const scanInput = {...input(), input: /** @type {import('text-scanner').InputConfig} */ (/** @type {unknown} */ ({searchTerms: false, searchKanji: true}))};
    sources.push(source('猫'));
    await Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, scanInput);
    await scanner.searchLast();
    expect(lookup).not.toHaveBeenCalled();
    expect(kanjiFind).toHaveBeenCalledTimes(2);
    expect(success.mock.lastCall?.[0].type).toBe('kanji');
});

test('a term-only refresh miss does not expand into kanji fallback', async () => {
    const {scanner, lookup, sources, empty} = setup();
    const kanjiFind = vi.fn().mockResolvedValue([]);
    Reflect.set(scanner, '_searchKanji', true);
    Reflect.get(scanner, '_api').kanjiFind = kanjiFind;
    const scanInput = {...input(), input: /** @type {import('text-scanner').InputConfig} */ (/** @type {unknown} */ ({searchTerms: true, searchKanji: false}))};
    sources.push(source('猫'));
    await Reflect.get(scanner, '_searchAt').call(scanner, 1, 1, scanInput);
    lookup.mockResolvedValueOnce({dictionaryEntries: [], originalTextLength: 0});
    await scanner.searchLast();
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(kanjiFind).not.toHaveBeenCalled();
    expect(empty).toHaveBeenCalledTimes(1);
});
