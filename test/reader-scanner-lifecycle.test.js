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
});
