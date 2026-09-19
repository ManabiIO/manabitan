/*
 * Copyright (C) 2023-2025  Yomitan Authors
 * Copyright (C) 2020-2022  Yomichan Authors
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

import {afterAll, afterEach, describe, expect, test, vi} from 'vitest';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {setupDomTest} from './fixtures/dom-test.js';

const testEnv = await setupDomTest();

/**
 * @typedef {object} TermsFindResult
 * @property {import('dictionary').TermDictionaryEntry[]} dictionaryEntries
 * @property {number} originalTextLength
 */

/**
 * @returns {(scanner: TextScanner, x: number, y: number, inputInfo: import('text-scanner').InputInfo) => Promise<void>}
 * @throws {Error}
 */
function getSearchAtMethod() {
    const searchAt = Reflect.get(TextScanner.prototype, '_searchAt');
    if (typeof searchAt !== 'function') {
        throw new Error('Expected TextScanner._searchAt to be available');
    }
    return (scanner, x, y, inputInfo) => searchAt.call(scanner, x, y, inputInfo);
}

/**
 * @param {string} text
 * @returns {import('text-source').TextSource}
 */
function createFakeTextSource(text) {
    return /** @type {import('text-source').TextSource} */ (/** @type {unknown} */ ({
        content: text,
        clone() { return createFakeTextSource(text); },
        text() { return text; },
        setStartOffset() { return 0; },
        setEndOffset() { return 0; },
        getNodesInRange() { return []; },
        getRects() { return []; },
        getWritingMode() { return 'horizontal-tb'; },
        hasSameStart() { return false; },
        cleanup() {},
    }));
}

/**
 * @returns {import('text-scanner').InputInfo}
 */
function createInputInfo() {
    /** @type {import('input').Modifier[]} */
    const modifiers = [];
    /** @type {import('input').ModifierKey[]} */
    const modifierKeys = [];
    return {
        input: null,
        pointerType: 'mouse',
        eventType: 'mouseMove',
        passive: false,
        modifiers,
        modifierKeys,
        detail: null,
    };
}

/**
 * @param {import('../ext/js/comm/api.js').API['termsFind']} termsFindImpl
 * @param {import('text-source').TextSource[]} sourceQueue
 * @returns {TextScanner}
 */
function createScanner(termsFindImpl, sourceQueue) {
    /** @type {import('text-scanner').GetSearchContextCallback} */
    const getSearchContext = () => ({
        optionsContext: {
            depth: 0,
            url: 'https://example.test/',
            modifiers: [],
            modifierKeys: [],
            pointerType: 'mouse',
        },
        detail: {
            documentTitle: 'scanner-test',
        },
    });
    const textSourceGenerator = /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({
        getRangeFromPoint() {
            return sourceQueue.shift() ?? createFakeTextSource('暗記');
        },
        extractSentence() {
            return {text: '', offset: 0};
        },
    }));
    const api = /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({
        termsFind: termsFindImpl,
        kanjiFind: async () => [],
        isTextLookupWorthy: async () => false,
    }));
    const scanner = new TextScanner({
        browser: 'chrome',
        api,
        node: window,
        getSearchContext,
        searchTerms: true,
        searchKanji: false,
        textSourceGenerator,
    });
    scanner.prepare();
    scanner.setEnabled(true);
    return scanner;
}

/**
 * @returns {import('dictionary').TermDictionaryEntry}
 */
function createMockTermEntry() {
    return /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({
        dictionary: 'JMdict',
        definitions: [],
    }));
}

/** @returns {{promise: Promise<TermsFindResult>, resolve: (value: TermsFindResult) => void, reject: (error: Error) => void}} */
function deferredLookup() {
    /** @type {(value: TermsFindResult) => void} */
    let resolve = () => {};
    /** @type {(error: Error) => void} */
    let reject = () => {};
    const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
}

/** @returns {TermsFindResult} */
function hit() { return {dictionaryEntries: [createMockTermEntry()], originalTextLength: 1}; }

describe('Reader integration scanner lifecycle regressions', () => {
    const searchAt = getSearchAtMethod();
    afterAll(async () => { await testEnv.teardown(global); });
    afterEach(() => { vi.useRealTimers(); });

    test('latest queued pointer lookup is not discarded when the previous lookup succeeds', async () => {
        /** @type {(value: TermsFindResult) => void} */
        let resolveFirst = () => {};
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        const termsFindImpl = vi.fn()
            .mockImplementationOnce(async () => await first)
            .mockResolvedValue({dictionaryEntries: [createMockTermEntry()], originalTextLength: 2});
        const termsFind = /** @type {import('../ext/js/comm/api.js').API['termsFind']} */ (/** @type {unknown} */ (termsFindImpl));
        const scanner = createScanner(termsFind, [createFakeTextSource('猫'), createFakeTextSource('学校')]);
        try {
            const active = searchAt(scanner, 10, 10, createInputInfo());
            await vi.waitFor(() => { expect(termsFindImpl).toHaveBeenCalledOnce(); });
            await searchAt(scanner, 20, 10, createInputInfo());
            resolveFirst({dictionaryEntries: [createMockTermEntry()], originalTextLength: 1});
            await active;
            await vi.waitFor(() => { expect(termsFindImpl).toHaveBeenCalledTimes(2); });
        } finally {
            scanner.setEnabled(false);
        }
    });

    test('disabling the scanner invalidates an already running result before publication', async () => {
        /** @type {(value: TermsFindResult) => void} */
        let resolveFirst = () => {};
        const first = new Promise((resolve) => { resolveFirst = resolve; });
        const termsFindImpl = vi.fn().mockImplementationOnce(async () => await first);
        const termsFind = /** @type {import('../ext/js/comm/api.js').API['termsFind']} */ (/** @type {unknown} */ (termsFindImpl));
        const scanner = createScanner(termsFind, [createFakeTextSource('猫')]);
        const success = vi.fn();
        scanner.on('searchSuccess', success);
        try {
            const active = searchAt(scanner, 10, 10, createInputInfo());
            await vi.waitFor(() => { expect(termsFindImpl).toHaveBeenCalledOnce(); });
            scanner.setEnabled(false);
            resolveFirst({dictionaryEntries: [createMockTermEntry()], originalTextLength: 1});
            await active;
            expect(success).not.toHaveBeenCalled();
        } finally {
            scanner.setEnabled(false);
        }
    });

    test('several queued pointer moves coalesce to the newest eligible position', async () => {
        const first = deferredLookup();
        const lookup = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫'), createFakeTextSource('学校')]);
        const generator = Reflect.get(scanner, '_textSourceGenerator');
        const range = vi.spyOn(generator, 'getRangeFromPoint');
        try {
            const active = searchAt(scanner, 1, 1, createInputInfo());
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledOnce(); });
            await searchAt(scanner, 2, 2, createInputInfo());
            await searchAt(scanner, 3, 3, createInputInfo());
            first.resolve(hit());
            await active;
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledTimes(2); });
            expect(range.mock.calls.map((args) => args.slice(0, 2))).toEqual([[1, 1], [3, 3]]);
        } finally {
            scanner.setEnabled(false);
            first.resolve(hit());
            range.mockRestore();
        }
    });

    test.each(['empty', 'rejection'])('queued work continues after a %s response', async (outcome) => {
        const first = deferredLookup();
        const lookup = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫'), createFakeTextSource('学校')]);
        try {
            const active = searchAt(scanner, 1, 1, createInputInfo());
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledOnce(); });
            await searchAt(scanner, 2, 2, createInputInfo());
            if (outcome === 'empty') {
                first.resolve({dictionaryEntries: [], originalTextLength: 0});
            } else {
                first.reject(new Error('Test provider failure'));
            }
            await active;
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledTimes(2); });
        } finally { scanner.setEnabled(false); first.resolve(hit()); }
    });

    test('old completion after disable/re-enable cannot clear newer busy state or its queued scan', async () => {
        const old = deferredLookup();
        const current = deferredLookup();
        const lookup = vi.fn().mockImplementationOnce(() => old.promise)
            .mockImplementationOnce(() => current.promise)
            .mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫'), createFakeTextSource('学校'), createFakeTextSource('魚')]);
        const success = vi.fn();
        scanner.on('searchSuccess', success);
        try {
            const active = searchAt(scanner, 1, 1, createInputInfo());
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledOnce(); });
            scanner.setEnabled(false);
            scanner.setEnabled(true);
            const newer = searchAt(scanner, 2, 2, createInputInfo());
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledTimes(2); });
            await searchAt(scanner, 3, 3, createInputInfo());
            old.resolve(hit());
            await active;
            expect(success).not.toHaveBeenCalled();
            expect(Reflect.get(scanner, '_pendingLookup')).toBe(true);
            expect(Reflect.get(scanner, '_queuedLookup')).toMatchObject({x: 3, y: 3});
            current.resolve(hit());
            await newer;
            await vi.waitFor(() => { expect(success).toHaveBeenCalledTimes(2); });
            expect(lookup).toHaveBeenCalledTimes(3);
        } finally {
            scanner.setEnabled(false);
            old.resolve(hit());
            current.resolve(hit());
        }
    });

    test('timeout advances the queue but retains source ownership until the actual operation settles', async () => {
        const first = deferredLookup();
        const source = createFakeTextSource('猫');
        const cleanup = vi.spyOn(source, 'cleanup');
        const lookup = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue(hit());
        const scanner = createScanner(lookup, [source, createFakeTextSource('学校')]);
        Reflect.set(scanner, '_lookupTimeoutMs', 20);
        const success = vi.fn();
        scanner.on('searchSuccess', success);
        try {
            const active = searchAt(scanner, 1, 1, createInputInfo());
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledOnce(); }, {interval: 1});
            await searchAt(scanner, 2, 2, createInputInfo());
            await active;
            await vi.waitFor(() => { expect(success).toHaveBeenCalledOnce(); });
            expect(cleanup).not.toHaveBeenCalled();
            first.resolve(hit());
            await vi.waitFor(() => { expect(cleanup).toHaveBeenCalledOnce(); });
            expect(success).toHaveBeenCalledOnce();
            expect(Reflect.get(scanner, '_pendingLookup')).toBe(false);
        } finally {
            scanner.setEnabled(false);
            first.resolve(hit());
            cleanup.mockRestore();
        }
    });

    test('disabled pointer entry points do not initiate lookups', async () => {
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫')]);
        scanner.setEnabled(false);
        await searchAt(scanner, 1, 1, createInputInfo());
        await Reflect.get(scanner, '_searchAtFromMouseMove').call(scanner, 1, 1, createInputInfo());
        expect(lookup).not.toHaveBeenCalled();
    });

    test('explicit programmatic search still works when pointer scanning is disabled', async () => {
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, []);
        const success = vi.fn();
        scanner.on('searchSuccess', success);
        scanner.setEnabled(false);
        await scanner.search(createFakeTextSource('猫'));
        expect(lookup).toHaveBeenCalledOnce();
        expect(success).toHaveBeenCalledOnce();
    });

    test('a passive scan delay cannot resurrect pointer work in the next enabled session', async () => {
        vi.useFakeTimers();
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫')]);
        Reflect.set(scanner, '_delay', 50);
        try {
            const pending = Reflect.get(scanner, '_searchAtFromMouseMove').call(scanner, 1, 1, {...createInputInfo(), passive: true});
            scanner.setEnabled(false);
            scanner.setEnabled(true);
            await vi.advanceTimersByTimeAsync(100);
            await pending;
            expect(lookup).not.toHaveBeenCalled();
            expect(Reflect.get(scanner, '_queuedMouseMoveLookup')).toBe(null);
        } finally { scanner.setEnabled(false); }
    });

    test('a scheduled coalesced pointer scan is cancelled on disable', async () => {
        vi.useFakeTimers();
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫')]);
        try {
            await Reflect.get(scanner, '_searchAtFromMouseMove').call(scanner, 1, 1, createInputInfo());
            scanner.setEnabled(false);
            scanner.setEnabled(true);
            await vi.advanceTimersByTimeAsync(100);
            expect(lookup).not.toHaveBeenCalled();
        } finally { scanner.setEnabled(false); }
    });

    test('an asynchronous ignored point replays the latest queued eligible point', async () => {
        /** @type {(ignored: boolean) => void} */
        let decide = () => {};
        const decision = new Promise((resolve) => { decide = resolve; });
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫')]);
        Reflect.set(scanner, '_ignorePoint', vi.fn().mockImplementationOnce(() => decision).mockResolvedValue(false));
        try {
            const active = searchAt(scanner, 1, 1, createInputInfo());
            await searchAt(scanner, 2, 2, createInputInfo());
            decide(true);
            await active;
            await vi.waitFor(() => { expect(lookup).toHaveBeenCalledOnce(); });
        } finally { scanner.setEnabled(false); decide(true); }
    });

    test('disable invalidates an asynchronous point-admission callback before it starts a lookup', async () => {
        /** @type {(ignored: boolean) => void} */
        let decide = () => {};
        const decision = new Promise((resolve) => { decide = resolve; });
        const lookup = vi.fn().mockResolvedValue(hit());
        const scanner = createScanner(lookup, [createFakeTextSource('猫')]);
        Reflect.set(scanner, '_ignorePoint', () => decision);
        const active = searchAt(scanner, 1, 1, createInputInfo());
        scanner.setEnabled(false);
        decide(false);
        await active;
        expect(lookup).not.toHaveBeenCalled();
    });
});
