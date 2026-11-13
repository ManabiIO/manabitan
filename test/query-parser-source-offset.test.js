/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {Backend} from '../ext/js/background/backend.js';
import {Display} from '../ext/js/display/display.js';
import {QueryParser} from '../ext/js/display/query-parser.js';
import {TextSourceRange} from '../ext/js/dom/text-source-range.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(() => { vi.restoreAllMocks(); });

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {string} text
 * @returns {Promise<QueryParser>}
 */
async function createParser(window, text) {
    window.document.body.innerHTML = '<div id="query-parser-content"></div><div id="query-parser-mode-container"><select id="query-parser-mode-select"></select></div>';
    const backend = /** @type {Backend} */ (Object.create(Backend.prototype));
    Reflect.set(backend, '_ensureDictionaryDatabaseReady', async () => {});
    Reflect.set(backend, '_getProfileOptions', () => ({}));
    Reflect.set(backend, '_getTranslatorFindTermsOptions', () => ({}));
    Reflect.set(backend, '_textParseCache', new Map());
    Reflect.set(backend, '_translator', {
        findTerms: async (/** @type {string} */ _mode, /** @type {string} */ query) => {
            const term = query.startsWith('食べる') ? '食べる' : (query.startsWith('犬') ? '犬' : null);
            if (term === null) { return {dictionaryEntries: [], originalTextLength: 0}; }
            return {
                dictionaryEntries: [{
                    headwords: [{term, reading: term === '犬' ? 'いぬ' : 'たべる', headwordIndex: 0, sources: [{originalText: term, isPrimary: true, matchType: 'exact'}]}],
                    frequencies: [],
                    pronunciations: [],
                }],
                originalTextLength: term.length,
            };
        },
    });
    const api = {
        parseText: (/** @type {string} */ query, /** @type {import('settings').OptionsContext} */ optionsContext) => backend._onApiParseText({text: query, optionsContext, scanLength: 20, useInternalParser: true, useMecabParser: false, useAllFrequencyDictionaries: false}, {}),
        modifySettings: async () => [{result: true}],
    };
    const parser = new QueryParser(
        /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)),
        /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({})),
        () => ({optionsContext: {depth: 0, url: 'https://example.test'}, detail: {documentTitle: 'Offset test'}}),
    );
    parser.setOptions({selectedParser: 'scan', termSpacing: false, readingMode: 'hiragana', useInternalParser: true, useMecabParser: false, useAllFrequencyDictionaries: false, language: 'ja', scanning: /** @type {import('text-scanner').Options} */ (/** @type {unknown} */ (null))});
    await parser.setText(text);
    return parser;
}

/**
 * @param {import('jsdom').DOMWindow} window
 * @param {QueryParser} parser
 * @param {string} original
 * @param {string} selected
 * @returns {import('display').HistoryParams}
 */
function navigate(window, parser, original, selected) {
    const walker = window.document.createTreeWalker(parser._queryParser, window.NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode()) !== null && (node.parentElement?.tagName === 'RT' || !node.textContent?.includes(selected))) { /* Find visible selected text. */ }
    if (node === null) { throw new Error('Selected parser text not found'); }
    const start = /** @type {string} */ (node.textContent).indexOf(selected);
    const range = window.document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + selected.length);
    const source = TextSourceRange.create(range);
    return navigateSource(parser, original, selected, source);
}

/**
 * @param {QueryParser} parser
 * @param {string} original
 * @param {string} selected
 * @param {TextSourceRange} source
 * @returns {import('display').HistoryParams}
 */
function navigateSource(parser, original, selected, source) {
    const display = /** @type {Display} */ (Object.create(Display.prototype));
    Reflect.set(display, '_fullQuery', original);
    Reflect.set(display, '_queryParserVisibleOverride', null);
    Reflect.set(display, '_history', {state: null});
    Reflect.set(display, 'getContentOrigin', () => ({tabId: 0, frameId: 0}));
    const publish = vi.spyOn(display, 'setContent').mockResolvedValue('completed');
    const onSearched = display._onQueryParserSearch.bind(display);
    parser.on('searched', onSearched);
    try {
        parser._onSearchSuccess({type: 'terms', dictionaryEntries: [], sentence: {text: original, offset: original.indexOf(selected)}, inputInfo: /** @type {import('text-scanner').EventArgument<'searchSuccess'>['inputInfo']} */ (/** @type {unknown} */ ({eventType: 'click'})), textSource: source, optionsContext: {depth: 0, url: 'https://example.test'}, detail: {documentTitle: 'Offset test'}, pageTheme: 'light'});
    } finally {
        parser.off('searched', onSearched);
    }
    const params = publish.mock.calls[0][0].params;
    expect(original.slice(Number(params.offset), Number(params.offset) + selected.length)).toBe(selected);
    return params;
}

test.for([
    {text: '食べる犬', selector: '#query-parser-content', childOffset: 1, selected: '犬', expectedOffset: 3},
    {text: '食べる犬', selector: '.query-parser-term', childOffset: 2, selected: '犬', expectedOffset: 3},
    {text: '𠮷犬', selector: '#query-parser-content', childOffset: 0, selected: '𠮷', expectedOffset: 0},
    {text: '𠮷犬', selector: '.query-parser-term', childOffset: 1, selected: '犬', expectedOffset: 2},
    {text: '食べる犬', selector: 'ruby', childOffset: 0, selected: '食', expectedOffset: 0},
    {text: '食べる犬', selector: 'ruby', childOffset: 1, selected: 'べる', expectedOffset: 1},
    {text: '猫   犬', selector: '#query-parser-content', childOffset: 1, selected: '犬', expectedOffset: 4},
])('element caret boundaries retain full-query source offsets: %j', async ({text, selector, childOffset, selected, expectedOffset}, {window}) => {
    const parser = await createParser(window, text);
    const container = parser._queryParser.matches(selector) ? parser._queryParser : parser._queryParser.querySelector(selector);
    if (container === null) { throw new Error('Parser caret container not found'); }
    const range = window.document.createRange();
    range.setStart(container, childOffset);
    range.collapse(true);
    const source = TextSourceRange.create(range);

    expect(source.setEndOffset([...selected].length, false, false)).toBe([...selected].length);
    expect(source.text()).toBe(selected);
    expect(navigateSource(parser, text, selected, source).offset).toBe(String(expectedOffset));
    expect(source.range.startContainer).toBe(container);
    expect(source.range.startOffset).toBe(childOffset);
});

test('plain kana following ruby retains its source offset in full-query navigation', async ({window}) => {
    const text = '食べる 犬';
    const parser = await createParser(window, text);
    expect(parser._queryParser.querySelector('ruby')).not.toBeNull();
    expect(navigate(window, parser, text, 'べる').offset).toBe('1');
});

for (const text of ['猫   犬', '猫\t\t犬', '猫\n\n犬', '\n\n猫   犬']) {
    test('normalized whitespace preserves following word source offsets: ' + JSON.stringify(text), async ({window}) => {
        const parser = await createParser(window, text);
        expect(navigate(window, parser, text, '犬').offset).toBe(String(text.indexOf('犬')));
    });
}

for (const [text, selected] of [['\n\n猫   犬', '猫'], ['\n\n\n𠮷 猫   犬', '𠮷'], ['𠮷   犬', '犬'], ['食べる   犬', 'べる'], ['食べる   犬', '犬']]) {
    test('visible text maps back to original code units: ' + JSON.stringify([text, selected]), async ({window}) => {
        const parser = await createParser(window, text);
        expect(navigate(window, parser, text, selected).offset).toBe(String(text.indexOf(selected)));
    });
}

test('unparsed preview keeps original leading whitespace offsets', async ({window}) => {
    const text = '\n\n𠮷   犬';
    const parser = await createParser(window, text);
    parser._setPreview(text);
    expect(navigate(window, parser, text, '犬').offset).toBe(String(text.indexOf('犬')));
});

test('parser switching maps each rendered grouping to the original sentence', async ({window}) => {
    const text = '食べる   犬';
    const parser = await createParser(window, text);
    parser._parseResults.push({id: 'mecab-test', source: 'mecab', dictionary: 'test', index: 1, content: [[{text: '食', reading: 'タ'}, {text: 'べる', reading: ''}], [{text: '   ', reading: ''}], [{text: '犬', reading: 'イヌ'}]]});
    parser._selectedParser = 'mecab-test';
    parser._renderParseResult();
    expect(navigate(window, parser, text, 'べる').offset).toBe('1');
    expect(navigate(window, parser, text, '犬').offset).toBe('6');
});

test('failed replacement leaves prior visible text source mapping usable', async ({window}) => {
    const text = '食べる   犬';
    const parser = await createParser(window, text);
    const current = parser._queryParser.firstChild;
    vi.spyOn(parser, '_convertReading').mockImplementationOnce(() => { throw new Error('Conversion failed'); });
    expect(() => parser._renderParseResult()).toThrow('Conversion failed');
    expect(parser._queryParser.firstChild).toBe(current);
    expect(navigate(window, parser, text, 'べる').offset).toBe('1');
    expect(navigate(window, parser, text, '犬').offset).toBe('6');
});
