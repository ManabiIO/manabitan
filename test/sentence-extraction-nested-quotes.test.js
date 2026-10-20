/*
 * Copyright (C) 2026  Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {expect, test} from 'vitest';
import {TextSourceElement} from '../ext/js/dom/text-source-element.js';
import {TextSourceGenerator} from '../ext/js/dom/text-source-generator.js';

/**
 * @param {string} text
 * @param {string} anchor
 * @param {boolean} [includeQuotes]
 * @returns {{text: string, offset: number}}
 */
function extract(text, anchor, includeQuotes = false) {
    const index = text.indexOf(anchor);
    if (index < 0) { throw new Error('Anchor missing'); }
    const source = new TextSourceElement(/** @type {Element} */ ({}), text, index, index + anchor.length);
    const generator = new TextSourceGenerator();
    const terminators = /** @type {import('text-scanner').SentenceTerminatorMap} */ (new Map([['。', [false, true]], ['！', [false, true]]]));
    const forward = /** @type {import('text-scanner').SentenceForwardQuoteMap} */ (new Map());
    const backward = /** @type {import('text-scanner').SentenceBackwardQuoteMap} */ (new Map());
    for (const [open, close] of [['「', '」'], ['『', '』'], ['〈', '〉']]) {
        forward.set(open, [close, includeQuotes]);
        backward.set(close, [open, includeQuotes]);
    }
    const result = generator.extractSentence(source, false, 200, false, terminators, forward, backward);
    expect(source.startOffset).toBe(index);
    expect(source.endOffset).toBe(index + anchor.length);
    expect(source.text()).toBe(anchor);
    return result;
}

for (const nested of ['「甲『乙』丙」', '「甲『乙〈丙〉丁』戊」']) {
    test('forward scanning closes nested quotes before applying the following terminator: ' + nested, () => {
        const sentence = '猫' + nested + '犬。';
        expect(extract(sentence + '次の文。', '猫')).toEqual({text: sentence, offset: 0});
    });
    test('backward scanning closes nested quotes before applying the preceding terminator: ' + nested, () => {
        const sentence = '猫' + nested + '犬';
        expect(extract('前の文。' + sentence, '犬')).toEqual({text: sentence, offset: [...sentence].length - 1});
    });
}

test('nested punctuation remains inside its closed quotation before the outer sentence ends', () => {
    const sentence = '猫「甲。『乙！』丙。」犬。';
    expect(extract(sentence + '次。', '猫')).toEqual({text: sentence, offset: 0});
    expect(extract('前。' + sentence, '犬')).toEqual({text: sentence, offset: [...sentence].indexOf('犬')});
});

test('successive closing quotes honor the include-at-end flag for every closing mark', () => {
    expect(extract('前。「『猫』」次。', '猫', true)).toEqual({text: '「『猫』」', offset: 2});
});

test('included three-level quote boundaries remain balanced', () => {
    expect(extract('前。「『〈猫〉』」次。', '猫', true)).toEqual({text: '「『〈猫〉』」', offset: 3});
});

test('excluded quote boundaries stay excluded around the selected word', () => {
    expect(extract('前。「『猫』」次。', '猫')).toEqual({text: '猫', offset: 0});
});

test('a single quote pair surrounding a neighboring phrase keeps ordinary sentence boundaries', () => {
    const sentence = '猫「甲」犬。';
    expect(extract('前。' + sentence + '次。', '猫')).toEqual({text: sentence, offset: 0});
    expect(extract('前。' + sentence + '次。', '犬')).toEqual({text: sentence, offset: [...sentence].indexOf('犬')});
});

test('supplementary characters inside nested quotes preserve the sentence and code-point offset', () => {
    const sentence = '𠮷「甲『𠮷野』丙」犬。';
    expect(extract('前。' + sentence + '次。', '犬')).toEqual({text: sentence, offset: [...sentence].indexOf('犬')});
});
