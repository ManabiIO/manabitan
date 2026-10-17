/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, vi} from 'vitest';
import {TextSourceElement} from '../ext/js/dom/text-source-element.js';
import {TextSourceGenerator} from '../ext/js/dom/text-source-generator.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {TextScanner} from '../ext/js/language/text-scanner.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
const kinds = ['range', 'element'];
const optionsContext = {depth: 0, url: 'https://example.test/'};

/**
 * Offsets into DOM nodes/element strings use UTF-16, but movement uses code points.
 * @param {Document} document
 * @param {string} kind
 * @param {string} text
 * @param {number} [start]
 * @param {number} [end]
 * @returns {import('text-source').TextSource}
 */
function createSource(document, kind, text, start = 0, end = start) {
    const element = document.createElement(kind === 'element' ? 'button' : 'span');
    const node = document.createTextNode(text);
    element.append(node);
    document.body.append(element);
    if (kind === 'element') { return new TextSourceElement(element, text, start, end); }
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return TextSourceRange.create(range);
}

/**
 * @param {import('vitest').Mock} lookup
 * @param {boolean} layoutAwareScan
 * @returns {TextScanner}
 */
function createScanner(lookup, layoutAwareScan) {
    const scanner = new TextScanner({
        browser: 'chrome',
        node: window,
        api: /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ ({termsFind: lookup})),
        getSearchContext: () => ({optionsContext, detail: {documentTitle: 'unicode'}}),
        searchTerms: true,
        searchKanji: false,
        textSourceGenerator: new TextSourceGenerator(),
    });
    scanner.setOptions({scanLength: 20, layoutAwareScan, sentenceParsingOptions: {scanExtent: 0, terminationCharacterMode: 'none', terminationCharacters: []}});
    return scanner;
}

/**
 * @param {string} match
 * @returns {import('api').ApiReturn<'termsFind'>}
 */
function hit(match) {
    const entry = /** @type {import('dictionary').TermDictionaryEntry} */ (/** @type {unknown} */ ({dictionary: 'test', definitions: []}));
    return {dictionaryEntries: [entry], originalTextLength: match.length};
}

test.for(kinds.flatMap((kind) => [false, true].flatMap((layoutAwareScan) => [
    '\u{20bb7}', '\u{20bb7}野家', '猫\u{20bb7}', '\u{20bb7}\u{20000}', '猫',
].map((match) => ({kind, layoutAwareScan, match})))))('selects only the matched text: %j', async ({kind, layoutAwareScan, match}, {window}) => {
    const lookup = vi.fn().mockResolvedValue(hit(match));
    const scanner = createScanner(lookup, layoutAwareScan);
    const source = createSource(window.document, kind, `${match}を見る`);
    const success = vi.fn();
    const error = vi.fn();
    scanner.on('searchSuccess', success);
    scanner.on('searchError', error);

    await scanner.search(source);

    expect(error).not.toHaveBeenCalled();
    expect(success).toHaveBeenCalledOnce();
    const result = success.mock.calls[0][0];
    expect(result.textSource.text()).toBe(match);
    expect(result.sentence).toEqual({text: match, offset: 0});
    expect(scanner.getCurrentTextSource()?.text()).toBe(match);
    expect(lookup).toHaveBeenCalledOnce();
});

test.for(kinds)('shortened fallback preserves the matched code-point span: %s', async (kind, {window}) => {
    const match = '\u{20bb7}野家';
    const lookup = vi.fn()
        .mockResolvedValueOnce({dictionaryEntries: [], originalTextLength: 0})
        .mockResolvedValueOnce(hit(match));
    const scanner = createScanner(lookup, false);
    await scanner.search(createSource(window.document, kind, `${match}。次`));
    expect(lookup.mock.calls.map(([query]) => query)).toEqual([`${match}。次`, match]);
    expect(scanner.getCurrentTextSource()?.text()).toBe(match);
});

test.for(kinds)('availability-only results still select one complete character: %s', async (kind, {window}) => {
    const dictionaryAvailability = [{dictionary: 'test', status: 'temporarilyUnavailable'}];
    const lookup = vi.fn().mockResolvedValue({dictionaryEntries: [], originalTextLength: 0, dictionaryAvailability});
    const scanner = createScanner(lookup, false);
    const success = vi.fn();
    scanner.on('searchSuccess', success);
    await scanner.search(createSource(window.document, kind, '\u{20bb7}野家'));
    expect(scanner.getCurrentTextSource()?.text()).toBe('\u{20bb7}');
    expect(success).toHaveBeenCalledWith(expect.objectContaining({dictionaryAvailability}));
});

test.for(kinds.flatMap((kind) => ['\u{20bb7}', '\u{20bb7}\u{20000}', '猫', '\ud800', '\udc00'].map((text) => ({kind, text}))))(
    'source movement returns code points, not UTF-16 units: %j',
    ({kind, text}, {window}) => {
        const count = [...text].length;
        const source = createSource(window.document, kind, `${text}猫${text}`);
        expect(source.setEndOffset(count, false, false)).toBe(count);
        expect(source.text()).toBe(text);
        expect(source.setEndOffset(count + 1, true, false)).toBe(count + 1);
        expect(source.text()).toBe(`${text}猫${text}`);
        expect(source.setEndOffset(100, true, false)).toBe(0);

        window.document.body.replaceChildren();
        const backward = createSource(window.document, kind, `${text}猫`, text.length, text.length + 1);
        expect(backward.setStartOffset(count, false)).toBe(count);
        expect(backward.text()).toBe(`${text}猫`);
        expect(backward.setStartOffset(100, false)).toBe(0);
    },
);

test.for(kinds.flatMap((kind) => [
    {text: '\u{20bb7}。猫。犬\u{20bb7}\u{20bb7}', expected: {text: '猫。', offset: 0}},
    {text: '\u{20bb7}猫犬\u{20000}', expected: {text: '\u{20bb7}猫犬\u{20000}', offset: 1}},
].map((data) => ({kind, ...data}))))('sentence boundaries and offsets use code points: %j', ({kind, text, expected}, {window}) => {
    const start = text.indexOf('猫');
    const source = createSource(window.document, kind, text, start, start + 1);
    const result = new TextSourceGenerator().extractSentence(source, false, 100, true, new Map([['。', [false, true]]]), new Map(), new Map());
    expect(result).toEqual(expected);
    expect([...result.text][result.offset]).toBe('猫');
    expect(source.text()).toBe('猫');
});
