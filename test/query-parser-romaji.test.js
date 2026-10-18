/*
 * Copyright (C) 2026 Manabitan authors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {afterEach, expect, vi} from 'vitest';
import {log} from '../ext/js/core/log.js';
import {QueryParser} from '../ext/js/display/query-parser.js';
import {createDomTest} from './fixtures/dom-test.js';

const test = createDomTest();
afterEach(async () => {
    vi.doUnmock('../ext/js/language/ja/japanese-wanakana.js');
    // Resolve this queued unmock before a later test registers another factory for the same module.
    await import('../ext/js/language/ja/japanese-wanakana.js');
    vi.restoreAllMocks();
});

/**
 * @param {import('jsdom').DOMWindow} window
 * @returns {{parser: QueryParser, api: {parseText: import('vitest').Mock<(text: string) => Promise<import('api').ParseTextResultItem[]>>, modifySettings: import('vitest').Mock}, report: import('vitest').MockInstance<typeof log.error>}}
 */
function setup(window) {
    window.document.body.innerHTML = '<div id="query-parser-content"></div><div id="query-parser-mode-container"><select id="query-parser-mode-select"></select></div>';
    const api = {
        parseText: vi.fn(
            /**
             * @param {string} text
             * @returns {Promise<import('api').ParseTextResultItem[]>}
             */
            async (text) => results(text),
        ),
        modifySettings: vi.fn().mockResolvedValue([{result: true}]),
    };
    const parser = new QueryParser(
        /** @type {import('../ext/js/comm/api.js').API} */ (/** @type {unknown} */ (api)),
        /** @type {import('../ext/js/dom/text-source-generator.js').TextSourceGenerator} */ (/** @type {unknown} */ ({})),
        () => ({optionsContext: {depth: 0, url: 'https://example.test'}, detail: {documentTitle: 'Test'}}),
    );
    parser.setOptions(options('none'));
    const report = vi.spyOn(log, 'error').mockImplementation(() => {});
    return {parser, api, report};
}

/**
 * @param {string} text
 * @returns {import('api').ParseTextResultItem[]}
 */
function results(text) {
    return [{id: 'scanner', source: 'scanning-parser', dictionary: null, index: 0, content: [[{text, reading: `${text}-reading`}]]}];
}

/**
 * @param {import('settings').ParsingReadingMode} readingMode
 * @returns {import('display').QueryParserOptions}
 */
function options(readingMode) {
    return {
        selectedParser: 'scanner',
        termSpacing: false,
        readingMode,
        useInternalParser: true,
        useMecabParser: false,
        useAllFrequencyDictionaries: false,
        language: 'ja',
        scanning: /** @type {import('text-scanner').Options} */ (/** @type {unknown} */ (null)),
    };
}

/**
 * @returns {{pending: PromiseWithResolvers<Pick<typeof import('../ext/js/language/ja/japanese-wanakana.js'), 'convertToRomaji'>>, module: {convertToRomaji: import('vitest').Mock<(reading: string) => string>}, factory: import('vitest').Mock}}
 */
function delayedModule() {
    const pending = /** @type {PromiseWithResolvers<Pick<typeof import('../ext/js/language/ja/japanese-wanakana.js'), 'convertToRomaji'>>} */ (Promise.withResolvers());
    void pending.promise.catch(() => {});
    const factory = vi.fn(() => pending.promise);
    vi.doMock('../ext/js/language/ja/japanese-wanakana.js', factory);
    const convertToRomaji = vi.fn(
        /**
         * @param {string} reading
         * @returns {string}
         */
        (reading) => `romaji:${reading}`,
    );
    const module = {convertToRomaji};
    return {pending, module, factory};
}

test('delayed romaji initialization refreshes existing readings without reparsing or saving settings', async ({window}) => {
    const {parser, api} = setup(window);
    const {pending, module} = delayedModule();
    await parser.setText('current');
    parser.setOptions(options('romaji'));
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('current-reading');
    pending.resolve(module);
    await vi.dynamicImportSettled();
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('romaji:current-reading');
    expect(api.parseText).toHaveBeenCalledTimes(1);
    expect(api.modifySettings).not.toHaveBeenCalled();
});

test('converter completion uses current results rather than the query from before loading', async ({window}) => {
    const {parser} = setup(window);
    const {pending, module} = delayedModule();
    await parser.setText('old');
    parser.setOptions(options('romaji'));
    await parser.setText('new');
    pending.resolve(module);
    await vi.dynamicImportSettled();
    expect(parser._queryParser.querySelector('.query-parser-segment-text')?.textContent).toBe('new');
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('romaji:new-reading');
    expect(module.convertToRomaji).toHaveBeenCalledExactlyOnceWith('new-reading');
});

test('a delayed converter cannot override a newer non-romaji reading mode', async ({window}) => {
    const {parser} = setup(window);
    const {pending, module} = delayedModule();
    await parser.setText('current');
    parser.setOptions(options('romaji'));
    parser.setOptions(options('none'));
    const render = vi.spyOn(parser, '_renderParseResult');
    pending.resolve(module);
    await vi.dynamicImportSettled();
    expect(parser._japaneseWanakanaModule?.convertToRomaji).toBe(module.convertToRomaji);
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('');
    expect(module.convertToRomaji).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
});

test('converter completion does not resurrect cached results over a pending preview', async ({window}) => {
    const {parser, api} = setup(window);
    const {pending, module} = delayedModule();
    await parser.setText('old');
    parser.setOptions(options('romaji'));
    const parse = /** @type {PromiseWithResolvers<import('api').ParseTextResultItem[]>} */ (Promise.withResolvers());
    api.parseText.mockReturnValueOnce(parse.promise);
    const request = parser.setText('new');
    pending.resolve(module);
    await vi.dynamicImportSettled();
    expect(parser._japaneseWanakanaModule?.convertToRomaji).toBe(module.convertToRomaji);
    expect(parser._queryParser.textContent).toBe('new');
    expect(parser._queryParser.dataset.parsed).toBe('false');
    expect(module.convertToRomaji).not.toHaveBeenCalled();
    parse.resolve(results('new'));
    await request;
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('romaji:new-reading');
});

test('a failed converter load is reported, released and retried on a later options update', async ({window}) => {
    const {parser, api, report} = setup(window);
    const {pending} = delayedModule();
    await parser.setText('current');
    parser.setOptions(options('romaji'));
    const error = new Error('Converter temporarily unavailable');
    pending.reject(error);
    await vi.dynamicImportSettled();
    expect(report).toHaveBeenCalledTimes(1);
    expect(parser._japaneseWanakanaModuleImport).toBeNull();
    expect(parser._japaneseWanakanaModule).toBeNull();
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('current-reading');
    const retry = delayedModule();
    parser.setOptions(options('romaji'));
    retry.pending.resolve(retry.module);
    await vi.dynamicImportSettled();
    expect(retry.factory).toHaveBeenCalledTimes(1);
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('romaji:current-reading');
    expect(api.parseText).toHaveBeenCalledTimes(1);
});

test('repeated options updates share the pending import and reuse the loaded converter', async ({window}) => {
    const {parser} = setup(window);
    const {pending, module, factory} = delayedModule();
    await parser.setText('current');
    parser.setOptions(options('romaji'));
    const operation = parser._japaneseWanakanaModuleImport;
    parser.setOptions(options('romaji'));
    expect(parser._japaneseWanakanaModuleImport).toBe(operation);
    pending.resolve(module);
    await vi.dynamicImportSettled();
    const render = vi.spyOn(parser, '_renderParseResult');
    parser.setOptions(options('romaji'));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(render).not.toHaveBeenCalled();
});

test('async reading render failures preserve usable DOM, report safely and permit later retry', async ({window}) => {
    const {parser, report} = setup(window);
    const {pending, module} = delayedModule();
    await parser.setText('current');
    parser.setOptions(options('romaji'));
    const html = parser._queryParser.innerHTML;
    const error = new Error('Reading rendering failed');
    vi.spyOn(parser, '_createParseResult').mockImplementationOnce(() => { throw error; });
    report.mockImplementationOnce(() => { throw new Error('Reporting failed'); });
    pending.resolve(module);
    await vi.dynamicImportSettled();
    expect(report).toHaveBeenCalledExactlyOnceWith(error);
    expect(parser._queryParser.innerHTML).toBe(html);
    expect(parser.needsTextUpdate).toBe(true);
    await parser.setText('current');
    expect(parser.needsTextUpdate).toBe(false);
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('romaji:current-reading');
});

test('building replacement reading content cannot erase the last usable DOM on failure', async ({window}) => {
    const {parser} = setup(window);
    await parser.setText('current');
    const html = parser._queryParser.innerHTML;
    const error = new Error('Replacement content failed');
    vi.spyOn(parser, '_createParseResult').mockImplementationOnce(() => { throw error; });
    expect(() => parser._renderParseResult()).toThrow(error);
    expect(parser._queryParser.innerHTML).toBe(html);
});

test('real lazy-loaded converter refreshes kana readings to romaji', async ({window}) => {
    const {parser, api} = setup(window);
    api.parseText.mockResolvedValueOnce([{id: 'scanner', source: 'scanning-parser', dictionary: null, index: 0, content: [[{text: '\u65e5\u672c', reading: '\u306b\u307b\u3093'}]]}]);
    await parser.setText('\u65e5\u672c');
    parser.setOptions(options('romaji'));
    await vi.dynamicImportSettled();
    expect(parser._queryParser.querySelector('rt')?.textContent).toBe('nihon');
});
