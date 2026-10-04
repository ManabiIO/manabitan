/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterAll, afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {Frontend} from '../ext/js/app/frontend.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {setupDomTest} from './fixtures/dom-test.js';

const environment = await setupDomTest();
/** @type {TextScanner[]} */
const scanners = [];
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
    for (const scanner of scanners.splice(0)) { scanner.setEnabled(false); }
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});
afterAll(async () => { await environment.teardown(global); });

/** @returns {import('text-scanner').InputInfo} */
function input() {
    return {input: null, pointerType: 'mouse', eventType: 'mouseMove', passive: false, modifiers: [], modifierKeys: [], detail: null};
}

/** @returns {import('dictionary').TermDictionaryEntry} */
function entry() {
    return /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({dictionary: 'JMdict', definitions: []}));
}

/** @returns {import('api').ApiReturn<'termsFind'>} */
function hit() { return {dictionaryEntries: [entry()], originalTextLength: 1}; }

/**
 * @param {string} text
 * @returns {import('text-source').TextSource}
 */
function source(text) {
    return /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({
        content: text,
        text: () => text,
        clone: () => source(text),
        hasSameStart: () => false,
        setStartOffset: () => 0,
        setEndOffset: () => 0,
        getNodesInRange: () => [],
        getRects: () => [],
        getWritingMode: () => 'horizontal-tb',
        cleanup: vi.fn(),
    }));
}

/**
 * Exercises the real dismissal handlers and scanner publication, while replacing
 * only browser layout/API reads and popup presentation.
 * @returns {{frontend: Frontend, scanner: TextScanner, lookup: import('vitest').Mock, show: import('vitest').Mock, hide: import('vitest').Mock, error: import('vitest').Mock, empty: import('vitest').Mock, sources: import('text-source').TextSource[]}}
 */
function setup() {
    const sources = [source('猫'), source('犬'), source('鳥')];
    const lookup = vi.fn().mockResolvedValue(hit());
    const scanner = new TextScanner({
        browser: 'chrome',
        api: /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({termsFind: lookup})),
        node: window,
        getSearchContext: () => ({optionsContext: {depth: 0, url: 'https://example.test/', modifiers: [], modifierKeys: [], pointerType: 'mouse'}, detail: {documentTitle: 'dismissal-test'}}),
        searchTerms: true,
        searchKanji: false,
        textSourceGenerator: /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({
            getRangeFromPoint: () => sources.shift() ?? source('猫'),
            extractSentence: () => ({text: '', offset: 0}),
        })),
    });
    scanner.prepare();
    scanner.setEnabled(true);
    scanners.push(scanner);
    const frontend = /** @type {Frontend} */ (Object.create(Frontend.prototype));
    const show = vi.fn();
    const hide = vi.fn();
    for (const [key, value] of Object.entries({
        _textScanner: scanner,
        _clearSelectionRequest: null,
        _popup: {hide, clearAutoPlayTimer: vi.fn().mockResolvedValue(void 0)},
        _isPointerOverPopup: false,
        _debugSearchSuccessCount: 0,
        _updatePageDebugState: vi.fn(),
        _showContent: show,
    })) { Reflect.set(frontend, key, value); }
    const error = vi.fn();
    const empty = vi.fn();
    scanner.on('searchSuccess', frontend._onSearchSuccess.bind(frontend));
    scanner.on('searchError', error);
    scanner.on('searchEmpty', empty);
    return {frontend, scanner, lookup, show, hide, error, empty, sources};
}

/**
 * @param {TextScanner} scanner
 * @param {number} [x]
 * @returns {Promise<void>}
 */
function scan(scanner, x = 1) { return Reflect.get(scanner, '_searchAt').call(scanner, x, 1, input()); }

/**
 * @param {TextScanner} scanner
 * @param {boolean} [passive]
 * @returns {Promise<void>}
 */
function move(scanner, passive = false) {
    return Reflect.get(scanner, '_searchAtFromMouseMove').call(scanner, 1, 1, {...input(), passive});
}

describe.each(['escape', 'close-all'])('explicit %s dismissal', (mode) => {
    /** @param {Frontend} frontend */
    function dismiss(frontend) {
        if (mode === 'escape') {
            frontend._onApiClosePopup();
        } else {
            frontend._onClosePopups();
        }
    }

    test('a pending hover cannot reopen the popup, but fresh hover works', async () => {
        const {frontend, scanner, lookup, show, hide} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scan(scanner);
        dismiss(frontend);
        pending.resolve(hit());
        await active;
        const staleShowCount = show.mock.calls.length;
        const staleSelection = scanner.hasSelection();
        await scan(scanner, 2);
        expect(staleShowCount).toBe(0);
        expect(staleSelection).toBe(false);
        expect(scanner.isEnabled()).toBe(true);
        expect(show).toHaveBeenCalledTimes(1);
        expect(hide).toHaveBeenCalledExactlyOnceWith(mode === 'escape');
    });

    test('queued busy input is discarded rather than replayed after dismissal', async () => {
        const {frontend, scanner, lookup, show} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scan(scanner);
        await scan(scanner, 2);
        dismiss(frontend);
        pending.resolve(hit());
        await active;
        await vi.advanceTimersByTimeAsync(20);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(show).not.toHaveBeenCalled();
    });

    test('coalesced mouse input is discarded', async () => {
        const {frontend, scanner, lookup} = setup();
        await move(scanner);
        dismiss(frontend);
        await vi.advanceTimersByTimeAsync(20);
        expect(lookup).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('passive hover waiting for scan delay is discarded', async () => {
        const {frontend, scanner, lookup} = setup();
        Reflect.set(scanner, '_delay', 50);
        const delayed = move(scanner, true);
        dismiss(frontend);
        await vi.advanceTimersByTimeAsync(70);
        await delayed;
        expect(lookup).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    test('late completion cannot clear a newer lookup owner or its queued input', async () => {
        const {frontend, scanner, lookup, show, sources} = setup();
        const oldSource = sources[0];
        const older = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        const newer = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
        const oldScan = scan(scanner);
        dismiss(frontend);
        const cleanupBeforeSettlement = vi.mocked(oldSource.cleanup).mock.calls.length;
        const newScan = scan(scanner, 2);
        await scan(scanner, 3);
        older.resolve(hit());
        await oldScan;
        const stillBusy = Reflect.get(scanner, '_pendingLookup');
        const queuedX = Reflect.get(scanner, '_queuedLookup')?.x;
        newer.resolve(hit());
        await newScan;
        await vi.advanceTimersByTimeAsync(20);
        expect(cleanupBeforeSettlement).toBe(0);
        expect(oldSource.cleanup).toHaveBeenCalledTimes(1);
        expect(stillBusy).toBe(true);
        expect(queuedX).toBe(3);
        expect(lookup).toHaveBeenCalledTimes(3);
        expect(show).toHaveBeenCalledTimes(2);
        expect(Reflect.get(scanner, '_pendingLookup')).toBe(false);
    });

    test('an asynchronous point-admission check cannot start old work', async () => {
        const {frontend, scanner, lookup} = setup();
        const decision = /** @type {PromiseWithResolvers<boolean>} */ (Promise.withResolvers());
        Reflect.set(scanner, '_ignorePoint', () => decision.promise);
        const active = scan(scanner);
        dismiss(frontend);
        decision.resolve(false);
        await active;
        expect(lookup).not.toHaveBeenCalled();
    });

    test('dismissal during context loading skips the dictionary API', async () => {
        const {frontend, scanner, lookup, show} = setup();
        const pending = /** @type {PromiseWithResolvers<import('text-scanner').SearchContext>} */ (Promise.withResolvers());
        Reflect.set(scanner, '_getSearchContext', () => pending.promise);
        const active = scanner.search(source('猫'));
        dismiss(frontend);
        pending.resolve({optionsContext: {depth: 0, url: 'https://example.test/', modifiers: [], modifierKeys: [], pointerType: 'mouse'}, detail: {documentTitle: 'context-test'}});
        await active;
        expect(lookup).not.toHaveBeenCalled();
        expect(show).not.toHaveBeenCalled();
    });

    test('dismissed touch work cannot install click or scrolling suppression', async () => {
        const {frontend, scanner, lookup, show} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = Reflect.get(scanner, '_searchAtFromTouchStart').call(scanner, 1, 1, {...input(), pointerType: 'touch'});
        dismiss(frontend);
        pending.resolve(hit());
        await active;
        expect(show).not.toHaveBeenCalled();
        expect(Reflect.get(scanner, '_preventNextContextMenu')).toBe(false);
        expect(Reflect.get(scanner, '_preventNextMouseDown')).toBe(false);
        expect(Reflect.get(scanner, '_preventScroll')).toBe(false);
    });

    test('repeated dismissal is idempotent and permits a new coalesced hover', async () => {
        const {frontend, scanner, lookup, show} = setup();
        await move(scanner);
        dismiss(frontend);
        dismiss(frontend);
        await move(scanner);
        await vi.advanceTimersByTimeAsync(20);
        expect(lookup).toHaveBeenCalledTimes(1);
        expect(show).toHaveBeenCalledTimes(1);
    });

    test('late failure is suppressed, not presented as a fresh search error', async () => {
        const {frontend, scanner, lookup, error} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scan(scanner);
        dismiss(frontend);
        pending.reject(new Error('Dismissed lookup'));
        await active;
        expect(error).not.toHaveBeenCalled();
    });

    test('late empty results do not publish a new empty-search event', async () => {
        const {frontend, scanner, lookup, empty} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scan(scanner);
        dismiss(frontend);
        pending.resolve({dictionaryEntries: [], originalTextLength: 0});
        await active;
        expect(empty).not.toHaveBeenCalled();
    });

    test('an old programmatic lookup is suppressed; a fresh script search still works', async () => {
        const {frontend, scanner, lookup, show} = setup();
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scanner.search(source('猫'));
        dismiss(frontend);
        pending.resolve(hit());
        await active;
        const staleShowCount = show.mock.calls.length;
        scanner.setEnabled(false);
        await scanner.search(source('犬'));
        expect(staleShowCount).toBe(0);
        expect(show).toHaveBeenCalledTimes(1);
    });

    test('a pending selected-word rescan cannot republish after dismissal', async () => {
        const {frontend, scanner, lookup, show} = setup();
        await scan(scanner);
        Reflect.set(scanner, '_textSourceCurrentIncomplete', true);
        const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
        lookup.mockReturnValueOnce(pending.promise);
        const active = scanner.searchLast();
        dismiss(frontend);
        pending.resolve(hit());
        await active;
        expect(show).toHaveBeenCalledTimes(1);
        expect(scanner.hasSelection()).toBe(false);
    });
});

test('ordinary automatic hiding does not cancel the active replacement hover', async () => {
    const {frontend, scanner, lookup, show} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const active = scan(scanner);
    frontend._clearSelection(true);
    pending.resolve(hit());
    await active;
    expect(show).toHaveBeenCalledTimes(1);
    expect(scanner.hasSelection()).toBe(true);
});

test('disabling pointer scanning alone does not invalidate an explicit script lookup', async () => {
    const {scanner, lookup, show} = setup();
    const pending = /** @type {PromiseWithResolvers<import('api').ApiReturn<'termsFind'>>} */ (Promise.withResolvers());
    lookup.mockReturnValueOnce(pending.promise);
    const active = scanner.search(source('猫'));
    scanner.setEnabled(false);
    pending.resolve(hit());
    await active;
    expect(show).toHaveBeenCalledTimes(1);
});

test('Escape preserves modifier-key scanning at the last mouse position', async () => {
    const {frontend, scanner, lookup, show} = setup();
    vi.stubGlobal('PointerEvent', MouseEvent);
    Reflect.set(scanner, '_lastMouseMove', new MouseEvent('pointermove', {clientX: 12, clientY: 34}));
    Reflect.set(scanner, '_modifierKeySet', () => true);
    Reflect.set(scanner, '_getMatchingInputGroupFromEvent', () => input());
    frontend._onApiClosePopup();
    Reflect.get(scanner, '_onKeyDown').call(scanner, new KeyboardEvent('keydown', {key: 'Shift', shiftKey: true}));
    await vi.advanceTimersByTimeAsync(20);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledTimes(1);
});

test('close-all still clears remembered mouse input', () => {
    const {frontend, scanner} = setup();
    Reflect.set(scanner, '_lastMouseMove', new MouseEvent('pointermove', {clientX: 12, clientY: 34}));
    frontend._onClosePopups();
    expect(Reflect.get(scanner, '_lastMouseMove')).toBe(null);
});
