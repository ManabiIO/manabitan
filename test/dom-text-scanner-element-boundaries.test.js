/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect} from 'vitest';
import {DOMTextScanner} from '../ext/js/dom/dom-text-scanner.js';
import {TextSourceGenerator} from '../ext/js/dom/text-source-generator.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();

/**
 * @param {Document} document
 * @returns {HTMLElement}
 */
function createParagraph(document) {
    const paragraph = document.createElement('p');
    for (const text of ['before', 'target', 'after']) {
        const span = document.createElement('span');
        span.textContent = text;
        paragraph.append(span);
    }
    document.body.append(paragraph);
    return paragraph;
}

test.for([
    {offset: 0, length: 6, expected: 'before'},
    {offset: 1, length: 6, expected: 'target'},
    {offset: 2, length: 5, expected: 'after'},
    {offset: 1, length: -6, expected: 'before'},
    {offset: 2, length: -6, expected: 'target'},
    {offset: 3, length: -5, expected: 'after'},
])('scans from the specified child boundary: %j', ({offset, length, expected}, {window}) => {
    const paragraph = createParagraph(window.document);
    const scanner = new DOMTextScanner(paragraph, offset, true, false).seek(length);

    expect(scanner.content).toBe(expected);
    expect(scanner.remainder).toBe(0);
    expect(scanner.node.nodeValue).toBe(expected);
    expect(scanner.offset).toBe(length > 0 ? expected.length : 0);
});

test('a caret between child elements expands to the text after the caret', ({window}) => {
    const paragraph = createParagraph(window.document);
    const range = window.document.createRange();
    range.setStart(paragraph, 1);
    range.collapse(true);
    const source = TextSourceRange.create(range);

    expect(source.setEndOffset(6, false, false)).toBe(6);
    expect(source.text()).toBe('target');
    expect(source.range.toString()).toBe('target');
});

test('extending past a final element boundary preserves the existing selection', ({window}) => {
    const paragraph = createParagraph(window.document);
    const range = window.document.createRange();
    range.setStart(paragraph, 2);
    range.setEnd(paragraph, 3);
    const source = TextSourceRange.create(range);

    expect(source.setEndOffset(1, true, false)).toBe(0);
    expect(source.text()).toBe('after');
    expect(source.range.toString()).toBe('after');
});

test('sentence extraction uses the actual selected child boundaries', ({window}) => {
    const paragraph = createParagraph(window.document);
    const range = window.document.createRange();
    range.setStart(paragraph, 1);
    range.setEnd(paragraph, 2);
    const source = TextSourceRange.create(range);
    const result = new TextSourceGenerator().extractSentence(source, false, 100, false, new Map(), new Map(), new Map());

    expect(result).toEqual({text: 'beforetargetafter', offset: 6});
    expect(source.range.toString()).toBe('target');
});
