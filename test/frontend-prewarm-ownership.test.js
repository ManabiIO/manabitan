/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';

/** @returns {{frontend: Frontend, termsFind: ReturnType<typeof vi.fn>, prewarmContent: ReturnType<typeof vi.fn>, debug: ReturnType<typeof vi.fn>}} */
function setup() {
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    const termsFind = vi.fn().mockResolvedValue({dictionaryEntries: [{dictionary: 'current'}]});
    const prewarmContent = vi.fn().mockResolvedValue(void 0);
    const debug = vi.fn();
    Object.assign(frontend, {
        _options: {general: {enable: true}, dictionaries: []},
        _optionsUpdateToken: {},
        _textScanner: {isEnabled: () => true},
        _getOptionsContext: vi.fn().mockResolvedValue({url: 'https://example.test', depth: 0}),
        _getInitialLookupPrewarmTerms: () => ['same', 'fallback'],
        _getDictionaryLookupPrewarmTerms: vi.fn().mockResolvedValue([]),
        _application: {api: {termsFind}, tabId: 1, frameId: 0},
        _popup: {prewarmContent},
        _lookupPrewarmPromise: null,
        _popupPrewarmPromise: null,
        _popupContentPrewarmTerm: null,
        _updatePageDebugState: debug,
    });
    return {frontend, termsFind, prewarmContent, debug};
}

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

test('obsolete context acquisition cannot issue dictionary probes', async () => {
    const {frontend, termsFind, prewarmContent} = setup();
    const context = /** @type {PromiseWithResolvers<import('settings').OptionsContext>} */ (Promise.withResolvers());
    Reflect.set(frontend, '_getOptionsContext', () => context.promise);
    const pending = frontend._prewarmLookupForHover();
    Reflect.set(frontend, '_optionsUpdateToken', {});
    context.resolve({url: 'https://old.test', depth: 0});
    await pending;
    expect(termsFind).not.toHaveBeenCalled();
    expect(prewarmContent).not.toHaveBeenCalled();
});

test('options changes coalesce a fresh prewarm and suppress the old response', async () => {
    const {frontend, termsFind, prewarmContent, debug} = setup();
    const oldResult = /** @type {PromiseWithResolvers<{dictionaryEntries: Array<{dictionary: string}>}>} */ (Promise.withResolvers());
    termsFind.mockReturnValueOnce(oldResult.promise);
    frontend._startLookupPrewarmForHover();
    const first = frontend._lookupPrewarmPromise;
    await vi.waitFor(() => expect(termsFind).toHaveBeenCalledOnce());
    Reflect.set(frontend, '_optionsUpdateToken', {});
    frontend._startLookupPrewarmForHover();
    frontend._startLookupPrewarmForHover();
    oldResult.resolve({dictionaryEntries: [{dictionary: 'old-profile'}]});
    await first;
    await frontend._lookupPrewarmPromise;
    expect(termsFind).toHaveBeenCalledTimes(2);
    expect(prewarmContent).toHaveBeenCalledOnce();
    expect(prewarmContent.mock.calls[0][0].content.dictionaryEntries).toEqual([{dictionary: 'current'}]);
    expect(debug).not.toHaveBeenCalledWith(expect.objectContaining({lookupPrewarmMatchedTerm: 'fallback'}));
});

test('late popup completion cannot cache content for an obsolete options context', async () => {
    const {frontend, prewarmContent, debug} = setup();
    const rendered = /** @type {PromiseWithResolvers<void>} */ (Promise.withResolvers());
    prewarmContent.mockReturnValue(rendered.promise);
    const pendingContent = frontend._prewarmPopupContentForHover('same', /** @type {import('dictionary').DictionaryEntry[]} */ (/** @type {unknown} */ ([{dictionary: 'old'}])), {url: 'https://old.test', depth: 0});
    Reflect.set(frontend, '_optionsUpdateToken', {});
    rendered.resolve();
    await pendingContent;
    expect(frontend._popupContentPrewarmTerm).toBeNull();
    expect(debug).not.toHaveBeenCalledWith(expect.objectContaining({popupContentPrewarmReady: true}));
});

test('new options immediately invalidate the same-term prewarm marker', async () => {
    const {frontend, debug} = setup();
    frontend._popupContentPrewarmTerm = 'same';
    const context = /** @type {PromiseWithResolvers<import('settings').OptionsContext>} */ (Promise.withResolvers());
    Reflect.set(frontend, '_getOptionsContext', () => context.promise);
    const pending = frontend._updateOptionsInternal().catch(() => {});
    try {
        expect(frontend._popupContentPrewarmTerm).toBeNull();
        expect(debug).toHaveBeenCalledWith(expect.objectContaining({lookupPrewarmReady: false, popupContentPrewarmReady: false}));
    } finally {
        context.reject(new Error('Stop after observing synchronous invalidation'));
        await pending;
    }
});

test('obsolete probe loops stop before scheduling their next lookup', async () => {
    const {frontend, termsFind} = setup();
    const first = /** @type {PromiseWithResolvers<{dictionaryEntries: never[]}>} */ (Promise.withResolvers());
    termsFind.mockReturnValueOnce(first.promise);
    let current = true;
    const pending = frontend._runLookupPrewarmTerms(['first', 'second'], {url: 'https://example.test', depth: 0}, () => current);
    current = false;
    first.resolve({dictionaryEntries: []});
    await expect(pending.firstMatchedResultPromise).resolves.toBeNull();
    await pending.resultsPromise;
    expect(termsFind).toHaveBeenCalledOnce();
});


test('completed dictionary probes release their timeout immediately', async () => {
    vi.useFakeTimers();
    const {frontend} = setup();
    Reflect.set(frontend, '_application', {api: {getDictionaryTermProbe: vi.fn().mockResolvedValue({expression: 'word', reading: 'reading'})}});
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'current', enabled: true}]}));
    await expect(Frontend.prototype._getDictionaryLookupPrewarmTerms.call(frontend, options)).resolves.toEqual(['word', 'reading']);
    expect(vi.getTimerCount()).toBe(0);
});


test('obsolete dictionary probe collection stops before querying another dictionary', async () => {
    const {frontend} = setup();
    const first = /** @type {PromiseWithResolvers<null>} */ (Promise.withResolvers());
    const probe = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue(null);
    Reflect.set(frontend, '_application', {api: {getDictionaryTermProbe: probe}});
    const options = /** @type {import('settings').ProfileOptions} */ (/** @type {unknown} */ ({dictionaries: [{name: 'first', enabled: true}, {name: 'second', enabled: true}]}));
    let current = true;
    const pending = Frontend.prototype._getDictionaryLookupPrewarmTerms.call(frontend, options, () => current);
    current = false;
    first.resolve(null);
    await pending;
    expect(probe).toHaveBeenCalledOnce();
});
